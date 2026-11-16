"""Immutable public facts and schema constants for the Tamil POC."""

EXPERIMENT_VERSION = 1
TINY_VOCA_REVISION = "62e2adef158bc997042cc6234f541f1e0e4cd55d"
FLEURS_REPOSITORY = "google/fleurs"
FLEURS_CONFIG = "ta_in"
FLEURS_REVISION = "70bb2e84b976b7e960aa89f1c648e09c59f894dd"
FLEURS_LICENSE = "CC-BY-4.0"
TARGET_SAMPLE_RATE = 24_000
TARGET_CHANNELS = 1
TARGET_ENCODING = "PCM_16"

# FLEURS gives a coarse gender field but no speaker identity in the exposed schema.
UNKNOWN_SPEAKER = None

PROVENANCE_REQUIRED = frozenset((
    "experiment_version",
    "source_repository",
    "source_config",
    "source_revision",
    "source_license",
    "target_sample_rate",
    "target_channels",
    "target_encoding",
))
