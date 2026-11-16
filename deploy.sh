#!/usr/bin/env bash
# deploy.sh — despliega Cirrus de principio a fin en un solo comando.
#
# Uso:
#   ./deploy.sh                        # usa perfil "personal" y región us-east-1
#   AWS_PROFILE=miperfil ./deploy.sh
#   AWS_REGION=eu-west-1 ./deploy.sh
#
# Pasos que ejecuta:
#   1. sam build
#   2. sam deploy (primer pase — puede que SiteUrl aún sea '' o distinto;
#      si el stack ya está al día, continúa sin error)
#   3. Lee SiteUrl del output de CloudFormation
#   4. Si SiteUrl cambió respecto a samconfig.toml, hace sam deploy --no-confirm-changeset
#      con el valor correcto (segundo pase — solo actualiza el parámetro, es rápido)
#   5. Sube el frontend a S3 e invalida CloudFront
#
# Prerequisitos: aws CLI, sam CLI, perfil con permisos suficientes.

set -euo pipefail

export AWS_PROFILE="${AWS_PROFILE:-personal}"
export AWS_REGION="${AWS_REGION:-us-east-1}"
STACK="cirrus"

out() {
  aws cloudformation describe-stacks \
    --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" \
    --output text 2>/dev/null || true
}

echo "==> [1/5] sam build"
sam build

echo "==> [2/5] sam deploy (primer pase)"
# --no-fail-on-empty-changeset: si el stack ya está al día, sam no debe abortar el script
sam deploy --no-confirm-changeset --no-fail-on-empty-changeset

echo "==> [3/5] Leyendo outputs del stack"
SITE_URL=$(out SiteUrl)
BUCKET=$(out BucketName)
DIST_ID=$(out DistributionId)

if [ -z "$SITE_URL" ]; then
  echo "ERROR: el stack no exporta SiteUrl. Revisa el template.yaml."
  exit 1
fi
echo "    SiteUrl    : $SITE_URL"
echo "    BucketName : $BUCKET"
echo "    DistId     : $DIST_ID"

# Compara con el valor actual en samconfig.toml para saber si hay que redesplegar
CURRENT=$(grep -Po '(?<=SiteUrl = ")[^"]*' samconfig.toml 2>/dev/null || echo "")
if [ "$CURRENT" != "$SITE_URL" ]; then
  echo "==> [4/5] SiteUrl cambió ($CURRENT → $SITE_URL), segundo pase de sam deploy"
  # Actualiza samconfig.toml en disco para dejar el repo limpio
  sed -i "s|SiteUrl = \"[^\"]*\"|SiteUrl = \"$SITE_URL\"|" samconfig.toml
  sam deploy --no-confirm-changeset --no-fail-on-empty-changeset
else
  echo "==> [4/5] SiteUrl sin cambios, se omite el segundo pase"
fi

echo "==> [5/5] Subiendo frontend a S3 e invalidando CloudFront"
aws s3 sync web/ "s3://$BUCKET" --delete
aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths '/*' > /dev/null

echo ""
echo "✓ Despliegue completo: $SITE_URL"
