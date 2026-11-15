from orchestrator.callbrain import clean_reply


def test_strips_control_tokens():
    assert clean_reply("Sure thing. <listen>") == "Sure thing."


def test_degenerate_repeat_is_empty():
    assert clean_reply("tear " * 20) == ""


def test_normal_reply_untouched():
    assert clean_reply("It is about to rain, so take a coat.") == "It is about to rain, so take a coat."


def test_printed_tool_call_is_removed():
    assert "talk_with_harman" not in clean_reply('Sure. talk_with_harman(request="check cards") Done.')
