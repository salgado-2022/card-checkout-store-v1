# SPA rewrite for the default (S3) behavior of the CloudFront distribution.
# The function body is inline so the repository has no .js logic files.
# Extension-less paths that do not start with /api/ or /docs/ are served as /index.html;
# every other request (assets, API and docs paths) passes through unchanged.
resource "aws_cloudfront_function" "spa_rewrite" {
  name    = "${var.project_name}-spa-rewrite"
  runtime = "cloudfront-js-2.0"
  comment = "Rewrites extension-less non-API, non-docs paths to /index.html"
  publish = true
  code    = <<-EOT
    // SPA_REWRITE_START
    function handler(event) {
      var request = event.request;
      var uri = request.uri;
      if (uri.indexOf('/api/') === 0 || uri.indexOf('/docs/') === 0) {
        return request;
      }
      var lastSegment = uri.substring(uri.lastIndexOf('/') + 1);
      if (lastSegment.indexOf('.') !== -1) {
        return request;
      }
      request.uri = '/index.html';
      return request;
    }
    // SPA_REWRITE_END
  EOT
}

# Index rewrite for the static API docs under /docs. S3 has no per-prefix index,
# so /docs and /docs/ are mapped to /docs/index.html. Every other path is untouched.
resource "aws_cloudfront_function" "docs_index_rewrite" {
  name    = "${var.project_name}-docs-index-rewrite"
  runtime = "cloudfront-js-2.0"
  comment = "Rewrites /docs and /docs/ to /docs/index.html; every other /docs/* path is untouched"
  publish = true
  code    = <<-EOT
    // DOCS_INDEX_REWRITE_START
    function handler(event) {
      var request = event.request;
      if (request.uri === '/docs' || request.uri === '/docs/') {
        request.uri = '/docs/index.html';
      }
      return request;
    }
    // DOCS_INDEX_REWRITE_END
  EOT
}
