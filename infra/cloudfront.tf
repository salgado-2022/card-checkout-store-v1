# Managed policies, looked up by name so no opaque IDs live in the code.
data "aws_cloudfront_cache_policy" "caching_optimized" {
  name = "Managed-CachingOptimized"
}

data "aws_cloudfront_cache_policy" "caching_disabled" {
  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_origin_request_policy" "all_viewer_except_host_header" {
  name = "Managed-AllViewerExceptHostHeader"
}

locals {
  s3_origin_id     = "web-s3"
  lambda_origin_id = "api-lambda-url"
  # "https://<id>.lambda-url.<region>.on.aws/" -> "<id>.lambda-url.<region>.on.aws"
  lambda_origin_domain = trimsuffix(trimprefix(aws_lambda_function_url.api.function_url, "https://"), "/")
}

# Origin Access Control: CloudFront signs requests to the private web bucket.
resource "aws_cloudfront_origin_access_control" "web" {
  name                              = "${var.project_name}-web"
  description                       = "OAC for the private web bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# Single entry point: the SPA from S3 by default and the API under /api/*.
# The SPA rewrite is a CloudFront Function (not custom error responses), so
# API 404s are never turned into index.html.
resource "aws_cloudfront_distribution" "web" {
  enabled             = true
  comment             = "${var.project_name} web and API"
  default_root_object = "index.html"
  price_class         = "PriceClass_100"

  origin {
    origin_id                = local.s3_origin_id
    domain_name              = aws_s3_bucket.web.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.web.id
  }

  origin {
    origin_id   = local.lambda_origin_id
    domain_name = local.lambda_origin_domain

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }

    custom_header {
      name  = "X-Origin-Verify"
      value = random_password.origin_verify.result
    }
  }

  default_cache_behavior {
    target_origin_id           = local.s3_origin_id
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_optimized.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.spa_rewrite.arn
    }
  }

  ordered_cache_behavior {
    path_pattern               = "/api/*"
    target_origin_id           = local.lambda_origin_id
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_disabled.id
    origin_request_policy_id   = data.aws_cloudfront_origin_request_policy.all_viewer_except_host_header.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}
