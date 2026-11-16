// Textos de los correos en cada idioma. El idioma lo elige el emisor al crear el secreto
// (META.lang); si falta (secretos anteriores a esta opción) se usa español.
//
// Cada idioma expone las mismas claves. Los comandos de los checklists no se traducen: solo
// cambian los marcadores de posición (USUARIO / USERNAME) y la explicación de cada paso.

export const LANGS = ['es', 'en'];
export const DEFAULT_LANG = 'es';
export const normalizeLang = (l) => (LANGS.includes(l) ? l : DEFAULT_LANG);

// Un paso puede llevar un comando: va tras "\n   " (se muestra aparte en el HTML)
const es = {
  firstRead: {
    subject: (tag, reads, max) => `Cirrus${tag}: primer acceso al secreto (${reads} de ${max})`,
    heading: 'Tu secreto se abrió por primera vez',
    opened: (id, left, max) => `Tu secreto ${id} fue abierto por primera vez. ${left === 1 ? 'Queda 1 uso' : `Quedan ${left} usos`} de ${max}.`,
    stillActive: 'El link sigue activo hasta que se agoten los usos o expire.',
  },
  read: {
    subject: (tag, reads, max) => `Cirrus${tag}: tu secreto se leyó por completo (${reads} de ${max})`,
    heading: 'Tu secreto se leyó por completo',
    exhausted: (id) => `Tu secreto ${id} agotó sus usos. El link ya no sirve.`,
    stillAlive: 'Pero la credencial SIGUE ACTIVA en su cuenta de origen.',
  },
  expired: {
    subjectRead: (tag, reads, max) => `Cirrus${tag}: tu secreto expiró con ${reads} de ${max} lecturas`,
    headingRead: 'Tu secreto expiró',
    bodyRead: (id, reads, max) => `Tu secreto ${id} expiró. Se leyó ${reads} de ${max} veces.`,
    exposed: 'Como alguien lo leyó, la credencial sigue activa y expuesta.',
    subjectUnread: (tag) => `Cirrus${tag}: tu secreto expiró sin leerse`,
    headingUnread: 'Tu secreto expiró sin leerse',
    bodyUnread: (id, rotate) => `Tu secreto ${id} expiró sin que nadie lo leyera.${rotate ? ' Si ya no necesitas esa credencial, desactívala igualmente.' : ''}`,
  },
  reminder: {
    subject: (tag, n) => `Cirrus${tag}: recordatorio ${n} de 3, rota la credencial`,
    heading: (n) => `Recordatorio ${n} de 3: rota la credencial`,
    body: (id) => `Aún no confirmaste la rotación del secreto ${id}.`,
  },
  giveUp: {
    subject: (tag) => `Cirrus${tag}: último aviso, la credencial podría seguir activa`,
    heading: 'Último aviso',
    body: (id) => `Enviamos 3 recordatorios sobre el secreto ${id} sin confirmación. Dejamos de insistir; la credencial podría seguir activa.`,
  },
  checklistTitle: 'Checklist de rotación',
  ack: {
    intro: 'Cuando hayas rotado, confirma aquí (abre el link y pulsa el botón):',
    label: 'Confirmar que roté la credencial',
  },
  checklist(m) {
    const kid = m.keyId ?? 'TU_KEY_ID';
    const gkey = m.keyId ?? 'KEY_ID';
    const acct = m.account ?? 'SA_EMAIL';
    switch (m.credClass) {
      case 'aws-access-key':
        return [
          `Desactiva la key (reversible):\n   aws iam update-access-key --user-name USUARIO --access-key-id ${kid} --status Inactive`,
          `Confirma que nada se rompió y elimínala:\n   aws iam delete-access-key --user-name USUARIO --access-key-id ${kid}`,
          'Revisa su actividad reciente en CloudTrail.',
        ];
      case 'aws-temp':
        return ['Es una credencial temporal: expira sola. Revoca las sesiones del rol en IAM solo si su duración era larga.'];
      case 'gcp-sa':
        return [
          `Desactiva la clave (reversible):\n   gcloud iam service-accounts keys disable ${gkey} --iam-account=${acct}`,
          `Confirma que nada se rompió y elimínala:\n   gcloud iam service-accounts keys delete ${gkey} --iam-account=${acct}`,
          'Revisa su actividad reciente en Cloud Audit Logs.',
        ];
      case 'azure-secret':
        return [
          'Ubica el secreto en la aplicación:\n   az ad app credential list --id APP_ID',
          'Elimínalo:\n   az ad app credential delete --id APP_ID --key-id KEY_ID',
          'Revisa los inicios de sesión recientes de la aplicación en Microsoft Entra.',
        ];
      case 'github-token':
        return [
          'Elimina el token en GitHub: Settings > Developer settings > Personal access tokens.',
          'Revisa el registro de auditoría de la cuenta u organización en busca de uso inesperado.',
        ];
      case 'slack-token':
        return [
          'Revoca el token desde la configuración de la app en api.slack.com/apps (o reinstala la app para regenerarlo).',
          'Revisa los registros de acceso del workspace.',
        ];
      case 'pem':
        return ['Genera un par de claves nuevo, reemplaza la clave pública autorizada y elimina la anterior.'];
      case 'conn-string':
        return ['Cambia la contraseña del usuario de la base de datos y actualiza las aplicaciones que la usan.'];
      case 'env':
        return ['Rota cada secreto contenido en el archivo .env.'];
      default:
        return ['Rota o revoca la credencial en el sistema de origen.'];
    }
  },
};

const en = {
  firstRead: {
    subject: (tag, reads, max) => `Cirrus${tag}: first access to the secret (${reads} of ${max})`,
    heading: 'Your secret was opened for the first time',
    opened: (id, left, max) => `Your secret ${id} was opened for the first time. ${left === 1 ? '1 use' : `${left} uses`} left of ${max}.`,
    stillActive: 'The link stays active until its uses run out or it expires.',
  },
  read: {
    subject: (tag, reads, max) => `Cirrus${tag}: your secret was fully read (${reads} of ${max})`,
    heading: 'Your secret was fully read',
    exhausted: (id) => `Your secret ${id} has used up all its uses. The link no longer works.`,
    stillAlive: 'But the credential is STILL ACTIVE in its source account.',
  },
  expired: {
    subjectRead: (tag, reads, max) => `Cirrus${tag}: your secret expired after ${reads} of ${max} reads`,
    headingRead: 'Your secret expired',
    bodyRead: (id, reads, max) => `Your secret ${id} expired. It was read ${reads} of ${max} times.`,
    exposed: 'Since someone read it, the credential is still active and exposed.',
    subjectUnread: (tag) => `Cirrus${tag}: your secret expired unread`,
    headingUnread: 'Your secret expired unread',
    bodyUnread: (id, rotate) => `Your secret ${id} expired without anyone reading it.${rotate ? ' If you no longer need that credential, deactivate it anyway.' : ''}`,
  },
  reminder: {
    subject: (tag, n) => `Cirrus${tag}: reminder ${n} of 3, rotate the credential`,
    heading: (n) => `Reminder ${n} of 3: rotate the credential`,
    body: (id) => `You have not confirmed the rotation of secret ${id} yet.`,
  },
  giveUp: {
    subject: (tag) => `Cirrus${tag}: final notice, the credential may still be active`,
    heading: 'Final notice',
    body: (id) => `We sent 3 reminders about secret ${id} with no confirmation. We will stop here; the credential may still be active.`,
  },
  checklistTitle: 'Rotation checklist',
  ack: {
    intro: 'Once you have rotated it, confirm here (open the link and press the button):',
    label: 'Confirm that I rotated the credential',
  },
  checklist(m) {
    const kid = m.keyId ?? 'YOUR_KEY_ID';
    const gkey = m.keyId ?? 'KEY_ID';
    const acct = m.account ?? 'SA_EMAIL';
    switch (m.credClass) {
      case 'aws-access-key':
        return [
          `Deactivate the key (reversible):\n   aws iam update-access-key --user-name USERNAME --access-key-id ${kid} --status Inactive`,
          `Confirm nothing broke, then delete it:\n   aws iam delete-access-key --user-name USERNAME --access-key-id ${kid}`,
          'Review its recent activity in CloudTrail.',
        ];
      case 'aws-temp':
        return ['This is a temporary credential: it expires on its own. Revoke the role sessions in IAM only if their duration was long.'];
      case 'gcp-sa':
        return [
          `Disable the key (reversible):\n   gcloud iam service-accounts keys disable ${gkey} --iam-account=${acct}`,
          `Confirm nothing broke, then delete it:\n   gcloud iam service-accounts keys delete ${gkey} --iam-account=${acct}`,
          'Review its recent activity in Cloud Audit Logs.',
        ];
      case 'azure-secret':
        return [
          'Find the secret in the application:\n   az ad app credential list --id APP_ID',
          'Delete it:\n   az ad app credential delete --id APP_ID --key-id KEY_ID',
          'Review the application\'s recent sign-ins in Microsoft Entra.',
        ];
      case 'github-token':
        return [
          'Delete the token in GitHub: Settings > Developer settings > Personal access tokens.',
          'Check the account or organization audit log for unexpected use.',
        ];
      case 'slack-token':
        return [
          'Revoke the token from the app settings at api.slack.com/apps (or reinstall the app to regenerate it).',
          'Review the workspace access logs.',
        ];
      case 'pem':
        return ['Generate a new key pair, replace the authorized public key and delete the old one.'];
      case 'conn-string':
        return ['Change the database user\'s password and update the applications that use it.'];
      case 'env':
        return ['Rotate every secret contained in the .env file.'];
      default:
        return ['Rotate or revoke the credential in the source system.'];
    }
  },
};

const BY_LANG = { es, en };
export const messages = (lang) => BY_LANG[normalizeLang(lang)];
