// Hook de resolución de módulos: dentro de las pruebas, cualquier import de '@aws-sdk/*'
// se sustituye por el simulador en memoria de test/helpers/fake-sdk/.
// Así los handlers reales de src/ se prueban sin copiarlos ni instalar el SDK de AWS.
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const fakes = join(dirname(fileURLToPath(import.meta.url)), 'fake-sdk');

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@aws-sdk/')) {
    const name = specifier.slice('@aws-sdk/'.length);
    return { url: pathToFileURL(join(fakes, `${name}.mjs`)).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
