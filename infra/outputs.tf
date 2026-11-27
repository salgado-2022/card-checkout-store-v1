output "distribution_domain_name" {
  description = "CloudFront domain name serving the web SPA and the /api/v1 path."
  value       = aws_cloudfront_distribution.web.domain_name
}

output "distribution_id" {
  description = "CloudFront distribution ID, used to create cache invalidations on deploy."
  value       = aws_cloudfront_distribution.web.id
}

output "web_bucket_name" {
  description = "S3 bucket that stores the built web SPA assets."
  value       = aws_s3_bucket.web.bucket
}

output "lambda_function_name" {
  description = "Name of the NestJS API Lambda function updated on deploy."
  value       = aws_lambda_function.api.function_name
}
