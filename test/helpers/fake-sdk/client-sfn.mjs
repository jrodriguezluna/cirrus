// Step Functions simulado: registra las ejecuciones iniciadas y los SendTaskSuccess
export const started = [];     // inputs de StartExecution (incluye `input` como JSON)
export const succeeded = [];   // inputs de SendTaskSuccess

export class StartExecutionCommand { constructor(input) { this.input = input; } }
export class SendTaskSuccessCommand { constructor(input) { this.input = input; } }
export class SFNClient {
  async send(cmd) {
    (cmd instanceof StartExecutionCommand ? started : succeeded).push(cmd.input);
    return {};
  }
}
