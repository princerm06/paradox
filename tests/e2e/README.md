# Fork acceptance tests

These start a real engine process (`engine.api.create_app`) on free ports with a temp state dir. They drive it only over HTTP, the same way the frontend does.

    .venv/bin/pytest tests/e2e -q -rxX

`test_A_*` … `test_D_*` cover approved changes A–D (code-level modification, sprout `parent_id`, `modification` field, absolute `app_url`).
The tests read the documented `workspace/code/demo_app/` layout only to prove the change is in the code, not in config.
