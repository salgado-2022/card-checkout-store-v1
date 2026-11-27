output "state_bucket_name" {
  description = "Name of the Terraform state bucket. Stored in the TF_STATE_BUCKET repository variable."
  value       = aws_s3_bucket.state.bucket
}

output "deploy_role_arn" {
  description = "ARN of the role assumed by GitHub Actions through OIDC. Stored in the AWS_DEPLOY_ROLE_ARN repository variable."
  value       = aws_iam_role.deploy.arn
}

output "lambda_boundary_arn" {
  description = "ARN of the permissions boundary required on the Lambda execution role."
  value       = aws_iam_policy.lambda_boundary.arn
}
