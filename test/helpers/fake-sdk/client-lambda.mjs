// Lambda simulado: registra las invocaciones asíncronas (p. ej. notifyFirstRead desde reveal)
export const invoked = [];

export class InvokeCommand { constructor(input) { this.input = input; } }
export class LambdaClient {
  async send(cmd) { invoked.push(cmd.input); return {}; }
}
