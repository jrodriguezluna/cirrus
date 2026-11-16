// Importar este módulo ANTES de importar un handler de src/ (con import() dinámico):
// activa la sustitución de '@aws-sdk/*' por el simulador.
import { register } from 'node:module';

register('./loader.mjs', import.meta.url);
