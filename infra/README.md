# Infrastructure

Terraform code for the AWS environment in `us-east-2`: CloudFront with an S3 web bucket, a Lambda function with a Function URL, five provisioned DynamoDB tables, SSM parameters, CloudWatch logs with 7 days of retention, and a 1 USD budget alarm.

```text
infra/            main module, applied only by the deploy workflow
infra/bootstrap/  one-time module run by the developer (state bucket, deploy role; the GitHub OIDC provider already exists and is referenced by ARN)
```

## Local checks

These commands need no AWS credentials and do not read the remote state. Run them in `infra/` and in `infra/bootstrap/`:

```bash
terraform fmt -check -recursive
terraform init -backend=false
terraform validate
```

- `terraform fmt -check -recursive` fails if a file is not formatted. Run `terraform fmt -recursive` to fix it.
- `terraform init -backend=false` downloads the providers and skips the S3 backend.
- `terraform validate` checks the syntax and the variable rules.

Do not run `terraform init` with the S3 backend, `terraform plan` or `terraform apply` on your machine for `infra/`. The `deploy` workflow does this with OIDC credentials, and `apply` runs only after a reviewer approves it in the `production` environment.

## Deployment

The one-time setup (bootstrap, GitHub environment and variables, payment secrets, first run, verification and security notes) is in [docs/deployment.md](../docs/deployment.md).
