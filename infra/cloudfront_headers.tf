# Shared header values for the response headers policies below. Both policies read
# the same locals, so a change to HSTS, frame options, referrer policy or the CSP
# cannot drift between the web/API policy and the docs policy.
locals {
  hsts_max_age_seconds = 31536000
  frame_option         = "DENY"
  referrer_policy      = "strict-origin-when-cross-origin"
  permissions_policy   = "camera=(), microphone=(), geolocation=(), payment=()"

  # Content-Security-Policy directives. The docs policy differs only in img-src.
  csp_directives = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self'",
    "connect-src 'self' ${regex("^https://[^/]+", var.payment_api_url)}",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ]
  csp_security = join("; ", local.csp_directives)
  csp_docs = join("; ", [
    for directive in local.csp_directives :
    directive == "img-src 'self'" ? "img-src 'self' data:" : directive
  ])
}

# Response Headers Policy attached to the default S3 behavior and the /api/* Lambda
# behavior, so every response carries the same security headers (Requirements 13.3 to 13.5).
resource "aws_cloudfront_response_headers_policy" "security" {
  name    = "${var.project_name}-security-headers"
  comment = "Security headers for the web app and the API"
  security_headers_config {
    strict_transport_security {
      access_control_max_age_sec = local.hsts_max_age_seconds
      include_subdomains         = true
      override                   = true
    }
    content_type_options {
      override = true
    }
    frame_options {
      frame_option = local.frame_option
      override     = true
    }
    referrer_policy {
      referrer_policy = local.referrer_policy
      override        = true
    }
    content_security_policy {
      content_security_policy = local.csp_security
      override                = true
    }
  }
  custom_headers_config {
    items {
      header   = "Permissions-Policy"
      value    = local.permissions_policy
      override = true
    }
  }
}

# Response Headers Policy for the /docs and /docs/* behaviors. Identical to the security
# policy except img-src, which allows data: images for the docs site (Requirement 18.10).
resource "aws_cloudfront_response_headers_policy" "docs" {
  name    = "${var.project_name}-docs-headers"
  comment = "Security headers for the static API docs (img-src allows data:)"
  security_headers_config {
    strict_transport_security {
      access_control_max_age_sec = local.hsts_max_age_seconds
      include_subdomains         = true
      override                   = true
    }
    content_type_options {
      override = true
    }
    frame_options {
      frame_option = local.frame_option
      override     = true
    }
    referrer_policy {
      referrer_policy = local.referrer_policy
      override        = true
    }
    content_security_policy {
      content_security_policy = local.csp_docs
      override                = true
    }
  }
  custom_headers_config {
    items {
      header   = "Permissions-Policy"
      value    = local.permissions_policy
      override = true
    }
  }
}
