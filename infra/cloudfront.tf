# Managed policies, looked up by name so no opaque IDs live in the code.
data "aws_cloudfront_cache_policy" "caching_optimized" {
  name = "Managed-CachingOptimized"
}

data "aws_cloudfront_cache_policy" "caching_disabled" {
  name = "Managed-CachingDisabled"
}

# Only the viewer headers the API reads reach the Lambda Function URL. Host is never
# forwarded: the Function URL answers 403 to a foreign Host. X-Origin-Verify is an
# origin custom header, so it is set by the origin and not whitelisted here.
resource "aws_cloudfront_origin_request_policy" "api" {
  name    = "${var.project_name}-api"
  comment = "API viewer headers and query strings, no cookies, never Host"

  headers_config {
    header_behavior = "whitelist"
    headers {
      items = [
        "CloudFront-Viewer-Address",
        "Content-Type",
        "Accept",
        "Idempotency-Key",
        "X-Event-Checksum",
        "X-Request-Id",
      ]
    }
  }

  query_strings_config {
    query_string_behavior = "all"
  }

  cookies_config {
    cookie_behavior = "none"
  }
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
      origin_read_timeout    = 30
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

  # Static API docs from the S3 origin. "/docs" and "/docs/*" are separate patterns
  # because "/docs/*" does not match the exact string "/docs". Both use the docs
  # headers policy and the docs index function, never the SPA rewrite.
  ordered_cache_behavior {
    path_pattern               = "/docs"
    target_origin_id           = local.s3_origin_id
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_optimized.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.docs.id
    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.docs_index_rewrite.arn
    }
  }
  ordered_cache_behavior {
    path_pattern               = "/docs/*"
    target_origin_id           = local.s3_origin_id
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_optimized.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.docs.id
    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.docs_index_rewrite.arn
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
    origin_request_policy_id   = aws_cloudfront_origin_request_policy.api.id
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
