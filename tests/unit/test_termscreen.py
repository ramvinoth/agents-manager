"""The pty screen model renders what a terminal shows, not what is left after
deleting escape codes (card 204: Claude Code 2.1.302 draws with cursor moves)."""
import unittest

from orchestrator.termscreen import Screen


def render(data, cols=80, rows=24):
    s = Screen(cols=cols, rows=rows)
    s.feed(data)
    return s


class ScreenTest(unittest.TestCase):
    def test_absolute_column_moves_become_spaces(self):
        s = render(b"\x1b[2GThis\x1b[7Gwill\x1b[12Gguide\r\r\n")
        self.assertEqual(s.logical_lines()[0], " This will guide")

    def test_skipped_cell_keeps_previous_frame_character(self):
        # The diff renderer skips a cell that already holds the right character.
        s = render("\x1b[2G✻\x1b[4GGot code\r\x1b[2Gsk-ant-\x1b[10Gat01\x1b[K\r\n".encode())
        self.assertEqual(s.logical_lines()[0], " sk-ant-oat01")

    def test_cursor_up_and_erase_line_redraw(self):
        s = render(b"spinner 1\r\nnext\r\n\x1b[2A\x1b[2Kdone\r\n")
        self.assertEqual(s.logical_lines()[:2], ["done", "next"])

    def test_relative_moves_and_cup(self):
        s = render(b"ab\x1b[3Ccd\x1b[1;1HX\x1b[2;4HY")
        self.assertEqual(s.logical_lines()[:2], ["Xb   cd", "   Y"])

    def test_osc_hyperlink_and_private_modes_are_ignored(self):
        s = render(b"\x1b[?25l\x1b]8;id=1;https://x.test/a\x07https://x.test/a\x1b]8;;\x07\x1b[>0q\x1b[c ok")
        self.assertEqual(s.logical_lines()[0], "https://x.test/a ok")

    def test_sequences_and_utf8_split_across_chunks(self):
        s = Screen(cols=80)
        data = "\x1b[2G✻\x1b[4GHi\x1b]8;;\x07!".encode()
        for i in range(len(data)):
            s.feed(data[i:i + 1])
        self.assertEqual(s.logical_lines()[0], " ✻ Hi!")

    def test_autowrap_joins_into_one_logical_line(self):
        s = render(b"0123456789ABCDEF\r\nnext", cols=10)
        self.assertEqual(s.logical_lines(), ["0123456789ABCDEF", "next"])
        self.assertEqual(s.cursor_line(), 1)

    def test_exactly_full_row_then_newline_does_not_join(self):
        s = render(b"0123456789\r\nABCDEF", cols=10)
        self.assertEqual(s.logical_lines(), ["0123456789", "ABCDEF"])

    def test_text_since_shows_only_later_drawing(self):
        s = render(b"before\r\n\r\n")
        mark = s.seq
        s.feed(b"\x1b[2A\x1b[10Gafter")
        self.assertEqual(s.text(since=mark).strip(), "after")
        self.assertIn("before", s.text())

    def test_wide_characters_take_two_cells(self):
        s = render("界\x1b[3Gx".encode())
        self.assertEqual(s.logical_lines()[0], "界x")


if __name__ == "__main__":
    unittest.main()
