// SES simulado: guarda los correos "enviados" para poder inspeccionarlos
export const sent = [];   // { to, subject, text, html, from }

export class SendEmailCommand { constructor(input) { this.input = input; } }
export class SESv2Client {
  async send(cmd) {
    const i = cmd.input;
    const body = i.Content.Simple.Body;
    sent.push({
      from: i.FromEmailAddress,
      to: i.Destination.ToAddresses[0],
      subject: i.Content.Simple.Subject.Data,
      text: body.Text?.Data,
      html: body.Html?.Data,
    });
    return {};
  }
}
