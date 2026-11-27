# Deployment guide

One-time setup that enables automatic deployments of the web app and the API to AWS (`us-east-2`) from GitHub Actions. Follow the sections in order.

After the setup, every green `ci` run on `master` starts the `deploy` workflow:

```text
plan -> apply -> deploy-api -> deploy-web -> smoke-test
```

`apply`, `deploy-api` and `deploy-web` run in the `production` GitHub environment and wait for a reviewer. The workflow authenticates to AWS with OIDC. No AWS access key is stored in GitHub.

## 1. Prerequisites

- An AWS account and a local AWS CLI profile with permission to create S3 buckets and IAM roles and policies. This profile is used only for the bootstrap in section 2 and for the secrets in section 6.
- AWS CLI v2.
- Terraform 1.10 or later (the remote state uses the S3 lockfile, `use_lockfile = true`). The `deploy` workflow pins Terraform 1.15.6, so use that version locally to get the same plan.
- The GitHub OIDC identity provider (`token.actions.githubusercontent.com`, audience `sts.amazonaws.com`) already present in the AWS account. The bootstrap does not create, import or read it: the trust policy builds its ARN from the account id.
- A GitHub repository (this project uses `salgado-2022/card-checkout-store-v1`) with permission to manage environments and Actions variables, and `master` as the default branch. The OIDC trust policy names the `master` branch.
- Payment sandbox credentials from the payment provider: the public key, the private key, the integrity secret and the events secret, plus the sandbox API base URL.
- A project name for resource names and SSM paths. This guide uses the default `card-checkout-store`. Use the same value in the bootstrap and in `infra/` (`project_name`).

## 2. Bootstrap

Get the numeric ids first. GitHub puts them in the OIDC subject (`repo:<owner>@<owner_id>/<repo>@<repo_id>:...`), so the deploy role trusts this exact repository, even if another repository later takes the same name:
```bash
gh api users/<github-owner> --jq .id
gh api repos/<github-owner>/<github-repo> --jq .id
```

Run the bootstrap module once, from your machine. It creates the Terraform state bucket, the deploy role (which trusts the existing GitHub OIDC provider), and the permissions boundary for the Lambda execution role.

```bash
cd infra/bootstrap

terraform init

terraform plan \
  -var github_owner=<github-owner> \
  -var github_owner_id=<github-owner-id> \
  -var github_repo=<github-repo> \
  -var github_repo_id=<github-repo-id> \
  -var state_bucket_name=<globally-unique-bucket-name> \
  -var project_name=card-checkout-store

terraform apply \
  -var github_owner=<github-owner> \
  -var github_owner_id=<github-owner-id> \
  -var github_repo=<github-repo> \
  -var github_repo_id=<github-repo-id> \
  -var state_bucket_name=<globally-unique-bucket-name> \
  -var project_name=card-checkout-store
```

Read the plan before you confirm the apply. Then read the two outputs you need in section 4:

```bash
terraform output -raw deploy_role_arn
terraform output -raw state_bucket_name
```

The bootstrap uses local state, so `infra/bootstrap/terraform.tfstate` stays on your machine. It is git-ignored. Keep a backup of that file outside the repository, for example in an encrypted private location. If you lose it, you cannot manage the bootstrap resources with Terraform any more.

The bootstrap apply is the only manual infrastructure step. The developer re-applies it only when `infra/bootstrap` changes, as this branch requires. After it, all changes to `infra/` reach AWS through the `deploy` workflow.

> **Before deploying the `feat/HU-01-catalog-foundation` branch**, re-run the bootstrap apply once, with the exact same variables used the first time. Only the developer runs it, from a local machine. No workflow runs it.
>
> ```bash
> cd infra/bootstrap
> terraform apply \
>   -var github_owner=<github-owner> -var github_owner_id=<github-owner-id> \
>   -var github_repo=<github-repo> -var github_repo_id=<github-repo-id> \
>   -var state_bucket_name=<your-state-bucket-name> -var project_name=card-checkout-store
> ```
>
> The re-apply adds `dynamodb:Scan` on the products table to the Lambda permissions boundary. It also adds `dynamodb:PutItem`, `dynamodb:GetItem` and `dynamodb:DeleteItem` on the same table to the Deploy_Role, so the `infra/` apply can create the four seeded products. Skipping this step makes `terraform apply` in `infra/` fail with an access-denied error on the seed items. If that apply got through, `GET /api/v1/products` would fail at runtime until the boundary is updated.

## 3. Production environment

1. In GitHub, open **Settings > Environments > New environment** and create `production`.
2. Enable **Required reviewers** and add at least one reviewer. If you are the only reviewer, leave **Prevent self-review** off, otherwise you cannot approve your own runs.
3. Under **Deployment branches and tags**, select **Selected branches and tags** and allow only `master`.

Every run waits for a reviewer before any change reaches AWS. A rejection ends the run with no AWS change.

## 4. Deploy variables

Create these as **repository variables** in **Settings > Secrets and variables > Actions > Variables**. They are variables, not secrets. All six hold non-secret values.

| Variable | Scope | Where the value comes from |
|---|---|---|
| `AWS_ROLE_ARN` | Repository (the `plan` job has no environment and must read it) | Bootstrap output `deploy_role_arn` |
| `AWS_REGION` | Repository | `us-east-2` |
| `TF_STATE_BUCKET` | Repository | Bootstrap output `state_bucket_name` |
| `BUDGET_NOTIFICATION_EMAIL` | Repository | Your email address. AWS Budgets sends the 1 USD budget alerts here. |
| `PAYMENT_API_URL` | Repository | Base URL of the payment provider sandbox API (public value) |
| `PAYMENT_PUBLIC_KEY` | Repository | Public key of the payment sandbox. It starts with `pub_` and is bundled in the web build. |

The web bucket name, the CloudFront distribution id and domain, and the Lambda function name are not variables. The `apply` job reads them from Terraform outputs and passes them to the later jobs.

## 5. First deployment run

Create the payment secrets in section 6 before you start the first run.

1. Start the run in one of two ways:
   - Merge a pull request into `master`. When `ci` finishes green on `master`, `deploy` starts by itself.
   - Open **Actions > deploy > Run workflow**, choose the `master` branch and run it. Dispatch from `master` only: the `plan` job is skipped for any other branch, and the deploy role does not trust other branches.
2. Open the run and wait for the `plan` job. Read the **Plan summary** in the job summary. See section 8 for what to check.
3. Open the run page and select **Review deployments**, choose `production` and approve. The `apply` job starts. Each of the jobs `apply`, `deploy-api` and `deploy-web` targets `production`, so GitHub can ask for approval again for each one. Approve each request.
4. The `apply` job creates the infrastructure with a placeholder Lambda. `deploy-api` replaces it with the real API code, `deploy-web` uploads the web build and invalidates the CloudFront cache, and `smoke-test` checks the public URL.

The first run can take several minutes because CloudFront needs time to deploy.

To find the public domain, read the `DISTRIBUTION_DOMAIN` value in the `smoke-test` job log, or run:

```bash
aws cloudfront list-distributions --region us-east-2 \
  --query "DistributionList.Items[?Comment=='card-checkout-store web and API'].DomainName" \
  --output text
```

## 6. Payment secrets

Create the three payment secrets in SSM Parameter Store before the first run. Terraform does not manage them, so their values never enter the Terraform state or a plan. The Lambda reads them at cold start.

| Parameter name | Content |
|---|---|
| `/card-checkout-store/payment/private-key` | Private key of the payment sandbox |
| `/card-checkout-store/payment/integrity-secret` | Integrity secret of the payment sandbox |
| `/card-checkout-store/payment/events-secret` | Events secret of the payment sandbox |

Read each value from a local file, so it stays out of your shell history and process list:

```bash
# 1. Write the value to a local file outside the repository. Use an editor and
#    make sure the file has no trailing newline (the CLI stores the file as is).
#    To strip a trailing newline: tr -d '\n' < <raw-file> > <private-key-file>

# 2. Create the parameter.
aws ssm put-parameter \
  --region us-east-2 \
  --name /card-checkout-store/payment/private-key \
  --type SecureString \
  --value file://<private-key-file>

aws ssm put-parameter \
  --region us-east-2 \
  --name /card-checkout-store/payment/integrity-secret \
  --type SecureString \
  --value file://<integrity-secret-file>

aws ssm put-parameter \
  --region us-east-2 \
  --name /card-checkout-store/payment/events-secret \
  --type SecureString \
  --value file://<events-secret-file>

# 3. Delete the local files.
rm <private-key-file> <integrity-secret-file> <events-secret-file>
```

To confirm a parameter exists without printing its value, read only its version:

```bash
aws ssm get-parameter --region us-east-2 \
  --name /card-checkout-store/payment/private-key \
  --query Parameter.Version --output text
```

To change a secret later, run the same `put-parameter` command with `--overwrite`, delete the local file, and follow the rotation steps in section 8 so the Lambda reads the new value.

If you changed `project_name`, replace `card-checkout-store` in the parameter names.

## 7. Verification

### Automated smoke test

The `smoke-test` job runs this script. You can run it by hand against the public URL:

```bash
bash scripts/smoke-test.sh https://<distribution-domain>
```

The script accepts only URLs that start with `https://` and runs `curl` with `--proto '=https'`. For `/` and `/api/v1/health` it checks status 200, the six security headers, and for health the body `{"status":"ok"}`. Each check retries up to 5 times. Set `SMOKE_RETRY_DELAY=<seconds>` to change the pause between attempts (default 5). The requests never send `X-Origin-Verify`, so a passing run shows that CloudFront adds it. On failure the script prints the name of the failed check and exits with a non-zero code.

### Manual checks

Set the domain once:

```bash
DOMAIN=<distribution-domain>
```

1. **Six security headers on `/`.** The output must list `strict-transport-security`, `content-security-policy`, `x-content-type-options`, `x-frame-options`, `referrer-policy` and `permissions-policy`.

   ```bash
   curl -sSI "https://$DOMAIN/" | grep -iE '^(strict-transport-security|content-security-policy|x-content-type-options|x-frame-options|referrer-policy|permissions-policy):'
   ```

2. **Six security headers on `/api/v1/health`.** Same expected output.

   ```bash
   curl -sSI "https://$DOMAIN/api/v1/health" | grep -iE '^(strict-transport-security|content-security-policy|x-content-type-options|x-frame-options|referrer-policy|permissions-policy):'
   ```

3. **Health body.** Expected: `{"status":"ok"}`.

   ```bash
   curl -sS "https://$DOMAIN/api/v1/health"
   ```

4. **Direct Function URL returns 403.** The Function URL is not a Terraform output, so read it from AWS. A request without `X-Origin-Verify` must be rejected. Expected: `403`.

   ```bash
   FUNCTION_URL=$(aws lambda get-function-url-config --region us-east-2 \
     --function-name card-checkout-store-api --query FunctionUrl --output text)
   curl -sS -o /dev/null -w '%{http_code}\n' "${FUNCTION_URL}api/v1/health"
   ```

5. **Deep link returns `index.html`.** Expected: status `200`, content type `text/html`, and no difference between the two pages.

   ```bash
   curl -sS -o /dev/null -w '%{http_code} %{content_type}\n' "https://$DOMAIN/some/deep/route"
   diff <(curl -sS "https://$DOMAIN/") <(curl -sS "https://$DOMAIN/some/deep/route") && echo same
   ```

6. **HTTP redirects to HTTPS.** Expected: a `301` status and a `Location` header that starts with `https://`.

   ```bash
   curl -sSI "http://$DOMAIN/" | grep -iE '^(HTTP/|location:)'
   ```

7. **Unknown API route returns a JSON 4xx.** Expected: a 4xx status (404), `content-type: application/json` and a body with `statusCode`, `code`, `message` and `details`, not the HTML of `index.html`.

   ```bash
   curl -sS -i "https://$DOMAIN/api/v1/unknown-route"
   ```

## 8. Security notes

### Secrets stay out of GitHub, Terraform and the repository

Real payment secrets (private key, integrity secret, events secret) are never stored in GitHub (variables, secrets or environment settings), in Terraform files, in the Terraform state, or in the repository. They exist only in SSM Parameter Store, created by you with the AWS CLI, and in your git-ignored local `.env` during development. Terraform and the workflows never create, read or print them. The deploy role has no permission on the payment parameters.

The origin secret is different. Terraform generates it with `random_password` and stores it in SSM. CloudFront sends it to the Lambda as the `X-Origin-Verify` header. It is never printed by the workflow.

The Terraform plan file never leaves the runner and is never uploaded as an artifact, because it can contain sensitive values in plain text.

### Secret rotation

A secret change takes effect only after a Lambda cold start, because the function reads its parameters once at initialization.

- **Payment secret.** Run `aws ssm put-parameter --overwrite` as in section 6, delete the local file, then force a new cold start. Re-run the `deploy` workflow (the `deploy-api` job publishes new code, which starts fresh execution environments), or update the function configuration, for example by changing an environment variable value in the Lambda console.
- **Origin secret.** Terraform owns it through `random_password.origin_verify`, whose `keepers` map holds the variable `origin_secret_rotation` (default `"1"`, declared in `infra/variables.tf`). To rotate it, open a pull request to `master` that changes that default, for example from `"1"` to `"2"`. When the `keepers` value changes, Terraform replaces the password. The change reaches AWS only through `deploy.yml`, after the `production` reviewer approves the `apply` job. Nobody runs Terraform state commands on a local machine. The approved apply generates a new value, updates the SSM parameter and the CloudFront custom header. The Lambda reads the new value only after a cold start, so run the `deploy-api` job again or update the function configuration. Read the plan summary first: it must show the replacement of the random password and the dependent updates.
- **Short 403 window.** While you rotate the origin secret, the API can answer 403 for a short time. CloudFront and the Lambda switch to the new value at different moments. The state converges when the CloudFront distribution update finishes and the Lambda has a fresh execution environment. Run the smoke test after the rotation.

### Protect `master`

The `plan` job assumes the deploy role from `master` without the approval gate. The deploy role can replace the Lambda code, and that code runs with the Lambda role. Whoever can change `master` can therefore change what runs in AWS. To keep this safe:

- Protect `master` in **Settings > Branches**: require a pull request with at least one approving review, block force pushes and deletions, and enforce the rule for administrators too.
- Keep a required reviewer on the `production` environment, and restrict the environment to the `master` branch.
- Recommended: add a `CODEOWNERS` file that assigns `.github/workflows/`, `infra/` and `scripts/` to you, and turn on **Require review from Code Owners** in the branch protection rule.

### Review the plan before you approve

The repository is public, so the **Plan summary** in the job summary is public too. Terraform masks sensitive values, but read the summary before you approve: it must contain only the changes you expect and no real secret. If you see something unexpected, reject the deployment.

### Who runs `terraform apply`

`terraform apply` runs only in `deploy.yml`, for a plan created in the same approved job. No workflow destroys infrastructure. Agents and CI never run `terraform apply` or any other change to AWS outside `deploy.yml`. The only manual infrastructure step is the one-time bootstrap in section 2.
