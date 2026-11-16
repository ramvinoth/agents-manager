"""Hermetic provenance and local corpus-contract tests for Card 585."""

import hashlib
import inspect
import json
import shutil
import wave

import pytest

from experiments.tiny_voca_tamil import spec
from experiments.tiny_voca_tamil.audio_convert import AudioConversionError, convert_to_contract
from experiments.tiny_voca_tamil.fleurs_ingest import records_from_tsv
from experiments.tiny_voca_tamil.prepare_fleurs import PreparationError, build_manifest, build_row, write_manifest
from experiments.tiny_voca_tamil.provenance import ProvenanceError, canonical_json, provenance_fingerprint, source_identity
import experiments.tiny_voca_tamil.alignment as alignment
import experiments.tiny_voca_tamil.prepare_fleurs as prepare_fleurs
import experiments.tiny_voca_tamil.provenance as provenance
import experiments.tiny_voca_tamil.tamil_frontend as tamil_frontend


def _wav(path, *, rate=24_000, channels=1, frames=240):
    with wave.open(str(path), "wb") as stream:
        stream.setnchannels(channels)
        stream.setsampwidth(2)
        stream.setframerate(rate)
        stream.writeframes(b"\0\0" * channels * frames)


def _row(**overrides):
    row = {
        "source_row_id": "27",
        "split": "train",
        "transcript": "தமிழ் சோதனை",
        "audio": "train/27.wav",
        "speaker_id": None,
        "speaker_known": False,
        "source_audio_sha256": "0" * 64,
    }
    row.update(overrides)
    return row


def test_canonical_identity_and_fingerprint_are_deterministic():
    identity = source_identity()
    assert json.loads(canonical_json(identity)) == identity
    assert provenance_fingerprint(identity) == provenance_fingerprint(dict(reversed(list(identity.items()))))


def test_experiment_modules_do_not_import_production_call_path():
    forbidden = ("orchestrator", "deploy.call_bridge", "mobile-app", "speakrail")
    source = "\n".join(inspect.getsource(module) for module in (provenance, prepare_fleurs, tamil_frontend, alignment))
    assert not any(term in source for term in forbidden)


@pytest.mark.parametrize("field,value", [
    ("source_revision", "main"), ("source_license", "unknown"), ("extra", True),
])
def test_identity_pin_changes_are_rejected(field, value):
    identity = source_identity()
    identity[field] = value
    with pytest.raises(ProvenanceError):
        provenance_fingerprint(identity)


def test_manifest_is_ordered_byte_stable_and_keeps_unknown_speaker(tmp_path):
    audio_root = tmp_path / "audio"
    (audio_root / "train").mkdir(parents=True)
    _wav(audio_root / "train" / "27.wav")
    _wav(audio_root / "train" / "2.wav")
    rows = [_row(source_row_id="27"), _row(source_row_id="2", audio="train/2.wav")]
    first = build_manifest(rows, audio_root=audio_root)
    second = build_manifest(list(reversed(rows)), audio_root=audio_root)
    assert first == second
    assert [row["source_row_id"] for row in first] == ["2", "27"]
    assert all(row["speaker_id"] is None and row["speaker_known"] is False for row in first)
    output_a, output_b = tmp_path / "a.jsonl", tmp_path / "b.jsonl"
    write_manifest(output_a, first)
    write_manifest(output_b, second)
    assert output_a.read_bytes() == output_b.read_bytes()
    assert first[0]["audio_sha256"] == hashlib.sha256((audio_root / "train" / "2.wav").read_bytes()).hexdigest()
    assert first[0]["provenance"]["source_revision"] == spec.FLEURS_REVISION


@pytest.mark.parametrize("overrides", [
    {"speaker_id": "invented"}, {"speaker_known": True}, {"audio": "../outside.wav"},
    {"transcript": "   "}, {"split": "dev"},
])
def test_invalid_source_rows_fail_closed(tmp_path, overrides):
    (tmp_path / "train").mkdir()
    _wav(tmp_path / "train" / "27.wav")
    with pytest.raises(PreparationError):
        build_row(_row(**overrides), audio_root=tmp_path)


@pytest.mark.parametrize("kwargs", [{"rate": 16_000}, {"channels": 2}, {"frames": 0}])
def test_nonconforming_wav_is_rejected(tmp_path, kwargs):
    (tmp_path / "train").mkdir()
    _wav(tmp_path / "train" / "27.wav", **kwargs)
    with pytest.raises(PreparationError):
        build_row(_row(), audio_root=tmp_path)


def test_manifest_writer_rejects_unknown_format(tmp_path):
    with pytest.raises(PreparationError):
        write_manifest(tmp_path / "manifest.txt", [])


def test_local_conversion_is_contract_valid_and_deterministic(tmp_path):
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        pytest.skip("ffmpeg is required for the local conversion-contract test")
    source = tmp_path / "source.wav"
    _wav(source, rate=16_000, channels=2, frames=320)
    first, second = tmp_path / "first.wav", tmp_path / "second.wav"
    result_a = convert_to_contract(source, first, ffmpeg=ffmpeg)
    result_b = convert_to_contract(source, second, ffmpeg=ffmpeg)
    assert (result_a.sample_rate, result_a.channels) == (24_000, 1)
    assert result_a.source_sha256 == hashlib.sha256(source.read_bytes()).hexdigest()
    assert result_a.output_sha256 == result_b.output_sha256
    assert first.read_bytes() == second.read_bytes()
    assert result_a.duration_ms > 0


def test_conversion_failure_never_publishes_invalid_destination(tmp_path):
    destination = tmp_path / "output.wav"
    with pytest.raises(AudioConversionError):
        convert_to_contract(tmp_path / "missing.wav", destination)
    assert not destination.exists()


def test_fleurs_tsv_ingest_preserves_transcript_and_rejects_gender_as_identity(tmp_path):
    source = tmp_path / "dev.tsv"
    source.write_text(
        "27\t27.wav\tதமிழ் சோதனை\tதமிழ் சோதனை\tத ம ி ழ ்\t1000\tMALE\n",
        encoding="utf-8",
    )
    assert list(records_from_tsv(source, source_split="dev")) == [{
        "source_row_id": "27", "source_sentence_id": "27", "split": "validation", "transcript": "தமிழ் சோதனை",
        "normalized_transcript": "தமிழ் சோதனை", "source_audio": "dev/27.wav",
        "speaker_id": None, "speaker_known": False,
    }]


@pytest.mark.parametrize("contents,split", [
    ("27\tunsafe.wav\ttext\tnormalized\ttokens\t1000\n", "dev"),
    ("27\t../unsafe.wav\ttext\tnormalized\ttokens\t1000\tMALE\n", "dev"),
    ("", "unknown"),
])
def test_fleurs_tsv_ingest_rejects_invalid_source_rows(tmp_path, contents, split):
    source = tmp_path / "input.tsv"
    source.write_text(contents, encoding="utf-8")
    with pytest.raises(PreparationError):
        list(records_from_tsv(source, source_split=split))
