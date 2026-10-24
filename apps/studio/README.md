# Paradox studio

React workspace for Paradox. It reads the timeline engine at `http://127.0.0.1:8000` and shows the live application from the engine's `app_url`.

```bash
cd apps/studio
npm install
npm run dev
```

The studio serves `http://localhost:5173`. The existing prototype stays at `apps/prototype` on port 3000.

Selecting a timeline inspects it. It does not activate that timeline.
