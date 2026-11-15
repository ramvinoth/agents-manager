import struct

from orchestrator import callrecord


def test_wav_header_describes_16bit_mono_pcm():
    h = callrecord.wav_header(1000, 16000)
    assert len(h) == 44 and h[:4] == b"RIFF" and h[8:12] == b"WAVE"
    assert struct.unpack("<I", h[4:8])[0] == 1036
    assert struct.unpack("<IHHIIHH", h[16:36]) == (16, 1, 1, 16000, 32000, 2, 16)
    assert struct.unpack("<I", h[40:44])[0] == 1000


def test_safe_call_id_blocks_traversal():
    assert "/" not in callrecord.safe_call_id("../../etc/passwd")
