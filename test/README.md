# Pruebas de Cirrus

```bash
npm install          # una vez: puppeteer-core y axe-core (solo para las pruebas)
npm test             # unitarias: backend, detección, state machine, reglas de la CSP (~1 s, sin red ni navegador)
npm run test:ui      # interfaz en un Chrome real contra la API simulada (~2 min)
npm run test:all     # ambas
npm run dev:web      # la web en http://localhost:8080 con API simulada y las cabeceras reales de CloudFront
```

Ninguna prueba toca AWS. `test:ui` usa el Chrome instalado en el sistema; si no lo encuentra,
define `CHROME_PATH=/ruta/a/chrome` (si no hay ninguno, esas pruebas se omiten en vez de fallar).

## Qué cubre cada parte

| Carpeta | Qué prueba |
|---|---|
| `unit/backend.test.mjs` | Los handlers reales de `src/` (create, reveal, ack, status, lifecycle): validación, lectura atómica, avisos por email, rotación opcional, checklist por tipo de credencial |
| `unit/detect.test.mjs` | Reconocimiento del tipo de credencial (`web/detect.js`), falsos positivos y tipos aún no reconocidos |
| `unit/state-machine.test.mjs` | Integridad del ASL, reintentos, acciones que existen en `lifecycle` y enrutado según `rotate` |
| `unit/web-static.test.mjs` | Reglas de la CSP: sin estilos ni scripts en línea, recursos que existen, nada se interpreta como HTML |
| `ui/form.test.mjs` | Formulario, privacidad (el servidor solo recibe texto cifrado), seguimiento y rotación |
| `ui/reveal.test.mjs` | Revelar con cifrado real: un uso, varios usos, passphrase, expiración, links rotos |
| `ui/status-ack.test.mjs` | Página de estado en cada modo y confirmación de rotación |
| `ui/a11y.test.mjs` | axe-core (WCAG 2.1 A/AA), teclado, 320 px, movimiento reducido, tema claro, fuente bajo la CSP |

## Límites a tener presentes

- Los handlers se ejecutan contra un DynamoDB, SES y Step Functions **simulados** (`helpers/fake-sdk/`).
  Prueban la lógica de Cirrus, no el comportamiento real de AWS (permisos IAM, entrega de SES,
  ejecución real de la state machine). Eso solo se comprueba desplegando.
- Si un handler usa una expresión de DynamoDB que el simulador no conoce, falla con un mensaje claro:
  amplía `helpers/fake-sdk/lib-dynamodb.mjs`.
- `detect.test.mjs` documenta qué credenciales **no** se reconocen hoy. Si añades una, esa prueba
  fallará a propósito: actualízala y añade su checklist en `src/lifecycle` y su clase en `src/create`.
