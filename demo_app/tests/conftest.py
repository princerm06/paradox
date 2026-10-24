import pytest
from fastapi.testclient import TestClient

from demo_app.main import create_app


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(tmp_path)) as application_client:
        yield application_client
