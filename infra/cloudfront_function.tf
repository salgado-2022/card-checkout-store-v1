# SPA rewrite for the default (S3) behavior of the CloudFront distribution.
# The function body is inline so the repository has no .js logic files.
# Extension-less paths that do not start with /api/ are served as /index.html;
# every other request (assets, API paths) passes through unchanged.
resource "aws_cloudfront_function" "spa_rewrite" {
  name    = "${var.project_name}-spa-rewrite"
  runtime = "cloudfront-js-2.0"
  comment = "Rewrites extension-less non-API paths to /index.html"
  publish = true
  code    = <<-EOT
    // SPA_REWRITE_START
    function handler(event) {
      var request = event.request;
      var uri = request.uri;
      if (uri.indexOf('/api/') === 0) {
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
