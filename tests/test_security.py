from app.security import is_valid_signature, sign

BODY = b'{"hello": "world"}'


def test_correct_signature_is_valid():
    assert is_valid_signature("secret", BODY, sign("secret", BODY))


def test_wrong_secret_is_invalid():
    assert not is_valid_signature("secret", BODY, sign("other-secret", BODY))


def test_changed_body_is_invalid():
    assert not is_valid_signature("secret", b'{"hello": "evil"}', sign("secret", BODY))


def test_missing_signature_is_invalid():
    assert not is_valid_signature("secret", BODY, None)
    assert not is_valid_signature("secret", BODY, "")
