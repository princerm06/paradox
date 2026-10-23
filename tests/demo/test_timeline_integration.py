import socket

import pytest
from fastapi.testclient import TestClient

from engine.api import create_app


@pytest.fixture
def runtime_port():
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        return listener.getsockname()[1]


@pytest.fixture
def client(tmp_path, runtime_port):
    with TestClient(create_app(state_dir=tmp_path, runtime_port=runtime_port)) as client:
        yield client


def feed(client):
    response = client.get('/app/api/posts')
    assert response.status_code == 200, response.text
    return response.json()


def publish(client, content):
    response = client.post('/app/api/posts', json={'author': 'Explorer', 'content': content})
    assert response.status_code == 201, response.text
    return response.json()


def activate(client, timeline_id):
    response = client.post(f'/api/timelines/{timeline_id}/activate')
    assert response.status_code == 200, response.text
    assert response.json()['is_active'] is True


def sprout(client, name, modification='popular_feed'):
    response = client.post('/api/timelines/sprout', json={'name': name, 'modification': modification})
    assert response.status_code == 201, response.text
    return response.json()


def contents(client):
    return {post['content'] for post in feed(client)['posts']}


def test_parent_child_sibling_traversal_isolates_behavior_and_data(client):
    root_id = client.get('/api/timelines').json()['active_timeline_id']
    baseline = feed(client)
    assert baseline['ordering'] == 'chronological'
    shared = publish(client, 'Before the fork')
    child = sprout(client, 'Popular future')
    assert child['parent_id'] == root_id
    assert child['status'] == 'pending'
    popular = feed(client)
    assert popular['ordering'] == 'popular'
    assert popular['posts'][0]['likes'] == 8
    assert shared['content'] in contents(client)
    child_post = publish(client, 'Child only')
    assert client.post(f"/app/api/posts/{child_post['id']}/like").json()['likes'] == 1
    activate(client, root_id)
    assert feed(client)['ordering'] == 'chronological'
    assert 'Child only' not in contents(client)
    publish(client, 'Parent after fork')
    sibling = sprout(client, 'Unchanged sibling', modification='none')
    assert sibling['parent_id'] == root_id
    assert feed(client)['ordering'] == 'chronological'
    assert 'Parent after fork' in contents(client)
    publish(client, 'Sibling only')
    activate(client, child['id'])
    assert feed(client)['ordering'] == 'popular'
    assert 'Child only' in contents(client)
    assert 'Parent after fork' not in contents(client)
    assert 'Sibling only' not in contents(client)
    revisited = next(post for post in feed(client)['posts'] if post['content'] == 'Child only')
    assert revisited['likes'] == 1
    activate(client, sibling['id'])
    assert 'Sibling only' in contents(client)
    assert 'Child only' not in contents(client)
    activate(client, root_id)
    assert 'Parent after fork' in contents(client)
    assert 'Sibling only' not in contents(client)


def test_snapshot_restore_and_confirm_decline(client):
    root_id = client.get('/api/timelines').json()['active_timeline_id']
    child = sprout(client, 'Candidate')
    publish(client, 'Before checkpoint')
    response = client.post(f"/api/timelines/{child['id']}/snapshots")
    assert response.status_code == 201, response.text
    snapshot_id = response.json()['id']
    publish(client, 'After checkpoint')
    response = client.post(f"/api/timelines/{child['id']}/restore", json={'snapshot_id': snapshot_id})
    assert response.status_code == 200, response.text
    assert feed(client)['ordering'] == 'popular'
    assert 'Before checkpoint' in contents(client)
    assert 'After checkpoint' not in contents(client)
    assert client.post(f"/api/timelines/{child['id']}/confirm").json()['status'] == 'confirmed'
    activate(client, root_id)
    assert 'Before checkpoint' not in contents(client)
    declined = sprout(client, 'Rejected future')
    publish(client, 'Rejected post')
    response = client.post(f"/api/timelines/{declined['id']}/decline")
    assert response.status_code == 200, response.text
    assert response.json()['status'] == 'declined'
    assert client.get('/api/timelines').json()['active_timeline_id'] == root_id
    assert 'Rejected post' not in contents(client)
    assert client.post(f"/api/timelines/{declined['id']}/activate").status_code == 409
    activate(client, child['id'])
    assert 'Before checkpoint' in contents(client)


def test_engine_restart_preserves_both_timelines(tmp_path, runtime_port):
    with TestClient(create_app(state_dir=tmp_path, runtime_port=runtime_port)) as client:
        root_id = client.get('/api/timelines').json()['active_timeline_id']
        publish(client, 'Persistent parent')
        child = sprout(client, 'Persistent child')
        publish(client, 'Persistent child post')
    with TestClient(create_app(state_dir=tmp_path, runtime_port=runtime_port)) as client:
        assert client.get('/api/timelines').json()['active_timeline_id'] == child['id']
        assert feed(client)['ordering'] == 'popular'
        assert 'Persistent child post' in contents(client)
        activate(client, root_id)
        assert feed(client)['ordering'] == 'chronological'
        assert 'Persistent parent' in contents(client)
        assert 'Persistent child post' not in contents(client)
        activate(client, child['id'])
        assert 'Persistent child post' in contents(client)


def test_code_html_and_database_restore_together(client, tmp_path):
    root_id = client.get('/api/timelines').json()['active_timeline_id']
    original_page = client.get('/app/').text
    child = sprout(client, 'Source change future')
    baseline_snapshot = child['snapshot_id']
    code_dir = tmp_path / 'workspace' / 'code' / 'demo_app'
    source_path = code_dir / 'main.py'
    source = source_path.read_text()
    old_return = 'return {"status": "ok", "ordering": application.state.ordering}'
    new_return = 'return {"status": "future-ok", "ordering": application.state.ordering}'
    assert old_return in source
    source_path.write_text(source.replace(old_return, new_return))
    (code_dir / 'index.html').write_text(original_page.replace('The Feed', 'The Future Feed'))
    publish(client, 'Source future data')
    response = client.post(f"/api/timelines/{child['id']}/snapshots")
    assert response.status_code == 201, response.text
    changed_snapshot = response.json()['id']
    assert client.get('/app/api/health').json()['status'] == 'future-ok'
    assert 'The Future Feed' in client.get('/app/').text
    activate(client, root_id)
    assert client.get('/app/api/health').json()['status'] == 'ok'
    assert client.get('/app/').text == original_page
    assert 'Source future data' not in contents(client)
    activate(client, child['id'])
    assert client.get('/app/api/health').json()['status'] == 'future-ok'
    assert 'The Future Feed' in client.get('/app/').text
    assert 'Source future data' in contents(client)
    response = client.post(f"/api/timelines/{child['id']}/restore", json={'snapshot_id': baseline_snapshot})
    assert response.status_code == 200, response.text
    assert client.get('/app/api/health').json()['status'] == 'ok'
    assert client.get('/app/').text == original_page
    assert 'Source future data' not in contents(client)
    response = client.post(f"/api/timelines/{child['id']}/restore", json={'snapshot_id': changed_snapshot})
    assert response.status_code == 200, response.text
    assert client.get('/app/api/health').json()['status'] == 'future-ok'
    assert 'The Future Feed' in client.get('/app/').text
    assert 'Source future data' in contents(client)
