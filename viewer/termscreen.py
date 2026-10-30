"""viewer.termscreen — a small terminal screen model for reading CLI output off a pty.

Deleting escape codes is not the same as reading a screen. Claude Code (2.1.30x)
draws with absolute cursor moves instead of spaces (`This\\x1b[7Gwill`), and its
diff renderer skips cells that already hold the right character, so a token can
arrive as `sk-ant-\\x1b[10Gat01-…` with the `o` left over from the previous frame.
Stripping the codes from that byte stream yields `sk-ant-at01-…`. This module
keeps a grid of cells, applies the cursor moves and erases, and renders what a
terminal would show.

Handled: printable text (wide characters take two cells, combining marks join
the previous cell), CR, LF, BS, TAB, autowrap at the last column, CSI cursor
moves (A B C D E F G H f d), erases (K J X), ESC 7/8 save/restore. Every other
CSI, OSC (hyperlinks, titles), DCS/APC/PM/SOS string and charset select is
consumed and ignored. Incomplete sequences and UTF-8 split across chunks are
held until the next feed.

Each cell records the write counter at the time it was drawn, so a caller can
read only what was drawn after a moment (`text(since=screen.seq)`), wherever on
the screen it landed.
"""
import codecs
import re
import unicodedata

_CSI_RE = re.compile(r"\[([0-?]*)([ -/]*)([@-~])")
_STRING_INTRODUCERS = "]P_^X"   # OSC, DCS, APC, PM, SOS — all end at BEL or ST


class Screen:
    def __init__(self, cols=2000, rows=50):
        self.cols, self.height = cols, rows
        self.lines = [[]]       # rows of [char, seq] cells, scrollback included
        self.wrapped = [False]  # wrapped[i]: row i autowrapped onto row i+1
        self.row = self.col = self.top = 0
        self.seq = 0            # write counter; bumps on every drawn or erased cell
        self._saved = (0, 0)
        self._pending = ""
        self._decoder = codecs.getincrementaldecoder("utf-8")("replace")

    # ---- input ----
    def feed(self, data):
        """Apply bytes (or str) written to the terminal."""
        text = self._decoder.decode(data) if isinstance(data, bytes) else data
        s, self._pending = self._pending + text, ""
        i, n = 0, len(s)
        while i < n:
            c = s[i]
            if c == "\x1b":
                j = self._escape(s, i)
                if j is None:            # incomplete: wait for the next chunk
                    self._pending = s[i:]
                    return
                i = j
                continue
            if c == "\r":
                self.col = 0
            elif c == "\n":
                self._linefeed()
            elif c == "\b":
                self.col = max(0, min(self.col, self.cols - 1) - 1)
            elif c == "\t":
                self.col = min(self.cols - 1, (self.col // 8 + 1) * 8)
            elif c >= " " and c != "\x7f":
                self._put(c)
            i += 1

    def _escape(self, s, i):
        """Apply the escape sequence at s[i]; return the index after it, or None
        when the sequence is not complete yet."""
        if i + 1 >= len(s):
            return None
        kind = s[i + 1]
        if kind == "[":
            m = _CSI_RE.match(s, i + 1)
            if not m:
                # Unterminated so far, or malformed: wait unless it can never complete.
                rest = s[i + 2:]
                return None if re.fullmatch(r"[0-?]*[ -/]*", rest) else i + 2
            self._csi(m.group(1), m.group(2), m.group(3))
            return m.end()
        if kind in _STRING_INTRODUCERS:
            for j in range(i + 2, len(s)):
                if s[j] == "\x07":
                    return j + 1
                if s[j] == "\x1b" and j + 1 < len(s) and s[j + 1] == "\\":
                    return j + 2
            return None
        if kind in "()*+":           # charset select: ESC ( B
            return None if i + 2 >= len(s) else i + 3
        if kind == "7":
            self._saved = (self.row - self.top, self.col)
        elif kind == "8":
            self.row = self.top + self._saved[0]
            self.col = self._saved[1]
            self._ensure_row()
        return i + 2

    def _csi(self, params, inter, final):
        if inter or (params and params[0] in "<=>?"):
            return  # private modes, keyboard protocol queries, etc.
        nums = [int(p) if p.isdigit() else 0 for p in params.split(";")] if params else []

        def arg(k=0, default=1):
            v = nums[k] if k < len(nums) else 0
            return v if v > 0 else default

        bottom = self.top + self.height - 1
        if final == "A":
            self.row = max(self.top, self.row - arg())
        elif final == "B":
            self.row = min(bottom, self.row + arg())
        elif final == "C":
            self.col = min(self.cols - 1, self.col + arg())
        elif final == "D":
            self.col = max(0, min(self.col, self.cols - 1) - arg())
        elif final == "E":
            self.row, self.col = min(bottom, self.row + arg()), 0
        elif final == "F":
            self.row, self.col = max(self.top, self.row - arg()), 0
        elif final == "G":
            self.col = min(self.cols, arg()) - 1
        elif final in "Hf":
            self.row = self.top + min(self.height, arg(0)) - 1
            self.col = min(self.cols, arg(1)) - 1
        elif final == "d":
            self.row = self.top + min(self.height, arg()) - 1
        elif final == "K":
            self._ensure_row()
            mode = nums[0] if nums else 0
            line = self.lines[self.row]
            col = min(self.col, self.cols - 1)
            if mode == 0:
                self._erase(self.row, col, len(line))
                self.wrapped[self.row] = False
            elif mode == 1:
                self._erase(self.row, 0, col + 1)
            elif mode == 2:
                self._erase(self.row, 0, len(line))
                self.wrapped[self.row] = False
        elif final == "J":
            self._ensure_row()
            mode = nums[0] if nums else 0
            if mode == 0:
                self._erase(self.row, min(self.col, self.cols - 1), len(self.lines[self.row]))
                rows = range(self.row + 1, len(self.lines))
            elif mode == 1:
                self._erase(self.row, 0, min(self.col, self.cols - 1) + 1)
                rows = range(self.top, self.row)
            else:
                rows = range(self.top, len(self.lines))
            for r in rows:
                self._erase(r, 0, len(self.lines[r]))
                self.wrapped[r] = False
        elif final == "X":
            self._ensure_row()
            col = min(self.col, self.cols - 1)
            self._erase(self.row, col, min(len(self.lines[self.row]), col + arg()))
        # m (colours), r (scroll region), h/l (modes), n/c (reports) …: no text effect.
        self._ensure_row()

    # ---- grid ----
    def _ensure_row(self):
        while len(self.lines) <= self.row:
            self.lines.append([])
            self.wrapped.append(False)

    def _linefeed(self):
        self.row += 1
        if self.row > self.top + self.height - 1:
            self.top += 1   # scroll: the old top row stays as scrollback
        self._ensure_row()

    def _erase(self, row, start, end):
        line = self.lines[row]
        for c in range(start, min(end, len(line))):
            self.seq += 1
            line[c] = [" ", self.seq]

    def _put(self, ch):
        if unicodedata.combining(ch):
            line = self.lines[self.row]
            if self.col and self.col - 1 < len(line):
                line[self.col - 1][0] += ch
            return
        width = 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1
        if self.col + width > self.cols:      # deferred autowrap
            self.wrapped[self.row] = True
            self.col = 0
            self._linefeed()
        line = self.lines[self.row]
        while len(line) < self.col + width:
            line.append([" ", 0])
        self.seq += 1
        line[self.col] = [ch, self.seq]
        if width == 2:
            line[self.col + 1] = ["", self.seq]
        self.col += width

    # ---- output ----
    def logical_lines(self, since=0):
        """Rendered lines, autowrapped rows joined back into one line. With
        `since`, only cells drawn after that write counter show (others blank)."""
        out, cur = [], ""
        for row, cells in enumerate(self.lines):
            cur += "".join(ch if seq > since else (" " if ch else "") for ch, seq in cells)
            if not self.wrapped[row]:
                out.append(cur.rstrip())
                cur = ""
        if cur:
            out.append(cur.rstrip())
        return out

    def text(self, since=0):
        return "\n".join(self.logical_lines(since))

    def cursor_line(self):
        """Index (into logical_lines) of the line the cursor is on."""
        return sum(1 for r in range(min(self.row, len(self.lines))) if not self.wrapped[r])
