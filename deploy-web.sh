#!/usr/bin/env bash
set -euo pipefail
export AWS_PROFILE=${AWS_PROFILE:-personal}
export AWS_REGION=${AWS_REGION:-us-east-1}
out() { aws cloudformation describe-stacks --stack-name cirrus \
  --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
BUCKET=$(out BucketName); DIST=$(out DistributionId); SITE=$(out SiteUrl)
aws s3 sync web/ "s3://$BUCKET" --delete
aws cloudfront create-invalidation --distribution-id "$DIST" --paths '/*' > /dev/null
echo "Listo: $SITE"
