"""Turn a vendor payload into a NormalizedAlert, picking the normalizer by source type."""

from app.models import NormalizedAlert
from app.normalizers import azure_monitor, cloudwatch, datadog, generic
from app.registry import Source

NORMALIZERS = {
    "azure_monitor": azure_monitor.normalize,
    "cloudwatch": cloudwatch.normalize,
    "datadog": datadog.normalize,
    "generic": generic.normalize,
}


class NormalizationError(ValueError):
    """The payload doesn't look like what this source type should send."""


def normalize(source: Source, payload: dict) -> NormalizedAlert:
    if not isinstance(payload, dict):
        raise NormalizationError("payload must be a JSON object")
    try:
        return NORMALIZERS[source.type](payload, source)
    except (KeyError, TypeError, ValueError) as exc:
        raise NormalizationError(f"bad {source.type} payload: {exc!r}") from exc
