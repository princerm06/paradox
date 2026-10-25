# Paradox Factory desktop showcase

This branch builds **Paradox Droid Demo.app**, a portable Apple Silicon Tauri shell with the existing Studio and built-in demo engine. It is not the imported-project M2 candidate, and website/source Droid support alone does not prove packaged desktop generation.

## Release gate

**Known P1 — do not automatically merge or use real credentials:** the native shell reads a Keychain item and puts `FACTORY_API_KEY` in the Python engine's exec environment. A same-user process (including an unsandboxed generated demo) can read that environment via macOS process inspection. Keychain storage does not close this exposure. Credential isolation must be fixed/reviewed, or the user must explicitly accept this exact risk; no acceptance is implied here. No genuine desktop Factory generation is claimed by the offline suite.

On October 25, 2026, the user explicitly accepted this disclosed credential-exposure risk for the demo laptop only. This is a demo-only exception, not a security fix, general-release approval, imported M2 GO, or authorization for paid/provider calls. The offline gates and integration review still apply; the P1 remains open outside that accepted demo scope.

## Bundle and target setup

- Bundles relocatable CPython 3.9.25 with pinned Python dependencies, the engine, built-in demo, scripted fixtures, built Droid adapter, SDK 0.10.0, Node 24.22.1 and Droid CLI 0.249.0. Node/CLI inputs are SHA-256 pinned; no compiler or developer checkout is needed at runtime.
- Requires Apple Silicon macOS 11+ as configured by Tauri; actual verification applies only to the build/test host, not every macOS release. Repository inspection additionally requires `/usr/bin/git` (Xcode Command Line Tools). Real Factory execution would require network access and valid credentials, and remains unverified/blocked by P1.
- Resources resolve relative to `Contents/Resources/engine/`, not a build-machine `.venv`. Engine port **8120**, UI port **5192**; occupied ports prevent startup.
- Identifier/state: `dev.paradox.desktop.droid-demo`, `~/Library/Application Support/dev.paradox.desktop.droid-demo/`. This does not share the recording app's state. Quit checkpoints state; shell death closes the engine's stdin and stops its children.
- Ad-hoc signed, not notarized. On another Mac, Gatekeeper may require Privacy & Security → Open Anyway or an explicitly approved quarantine removal. Different-laptop execution has not been verified by the local suite.

The launcher looks up Keychain service `paradox-demo-factory-key`, account matching the app's `USER`; `PARADOX_DEMO_KEY_SERVICE` overrides only the service (offline tests use unique disposable items). Missing key selects the **scripted** engine default. A present key selects the **Droid** engine default and is passed to the engine, with the P1 above. Exporting a shell key is not the credential setup. Do not provision a real key until that gate is resolved. Studio still initially selects the free scripted provider; using Droid requires explicit selection and paid confirmation. Availability means local prerequisites exist, not that the provider authenticated or generated successfully.

The existing standard portable recording ZIP hardcodes scripted mode and lacks the bundled Node/CLI/SDK dependencies. Installing tools or exporting a key does not turn that unchanged ZIP into this Factory build. The imported M2 CLI-only credential launcher and its different Keychain contract are not used here.

## Build only this Factory script

```sh
cd engine/droid_adapter && npm ci && npm run build
cd ../../apps/studio && npm ci
cd ../desktop && npm ci
scripts/package-droid-demo.sh
```

Commit the intended desktop source before packaging. The script rejects tracked changes in its build inputs and embeds `Contents/Resources/engine/SOURCE_SHA`. It uses current-checkout engine/demo/Studio sources without modifying their implementation. Python archive and package downloads may occur; these are dependency fetches, not provider calls. Packaging clears inherited environment variables, uses a unique nonexistent test Keychain service, and never executes the Droid CLI. The adapter probe is local/keyless. CLI 0.249.0 and Node 24.22.1 inputs must match the script's hashes; `PARADOX_DEMO_DROID`/`PARADOX_DEMO_NODE` may select matching files.

Output is **`release-droid-demo/Paradox-Droid-Demo-arm64.zip`** in this checkout. `DROID-DEMO-COMPONENTS.txt` records pinned build inputs (signing may change executable bytes). The script verifies the original recording ZIP's expected `977061a6…9595` hash before building and again on exit, including failures. Set `PARADOX_RECORDING_ZIP` to its location if not at the documented developer default. It never writes that ZIP. Preserve the old Factory artifact separately as well.

**Do not run `scripts/package-portable.sh` in this branch.** It is the historical recording script, expects `Paradox.app`, and is incompatible with this branch's Factory product name. Use its original portable branch only under separate approval; never overwrite the approved recording ZIP.

## Offline verification

Extract the newly built ZIP to a fresh directory, then run:

```sh
PARADOX_DESKTOP_APP='/absolute/path/Paradox Droid Demo.app' npm run test:desktop
```

The suite starts the actual native bundle using an allowlisted environment (no inherited provider keys), launches its bundled engine, and drives its served Studio in **Playwright WebKit**, not native WKWebView automation. It refuses occupied desktop ports and temporarily preserves/restores existing demo app state. It queries only a random test-only Keychain service, removes its known dummy entry afterward, and never reads the normal user credential item.

1. Keyless launch: isolated state, scripted default, per-launch token, origin/auth guards, explicit Droid request rejected as unavailable.
2. Scripted built-in-demo workflow: generation, isolated future/preview, activation, restore, failure and cancellation; browser mutation firewall blocks non-scripted generation. Repository import is not covered by this suite.
3. Clean relaunch: persistent history, new token, previous token rejected.
4. Shell crash mid-scripted-generation: children stop and generation recovers as failed.
5. Clean quit: no app/engine children remain.
6. Known dummy Keychain value: local `/api/agents` reports Droid available/default; no generation is submitted, all stored generation records remain scripted. Explicitly demonstrates the known engine-environment P1 rather than claiming credential isolation.

These are **five keyless/scripted tests plus one dummy availability-only test**, not six genuine Droid-generation tests. Adapter runtime/probe and SDK unit tests are additional offline checks, not real Factory authentication, cancellation or restart evidence. No real credentials, provider calls, project uploads, imported-project execution, or genuine live generation are authorized by this workflow.
