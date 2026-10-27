terraform {
  required_version = ">= 1.5, < 2.0"
  required_providers {
    docker = {
      source  = "kreuzwerker/docker"
      version = "~> 4.6.0"
    }
  }
}

provider "docker" {}

variable "port" {
  type        = number
  default     = 8092
  description = "Loopback port for the Terraform demo."
  validation {
    condition     = var.port >= 1024 && var.port <= 65535 && floor(var.port) == var.port
    error_message = "Choose an integer port between 1024 and 65535."
  }
}

resource "docker_image" "web" {
  name         = "nginxinc/nginx-unprivileged:1.29-alpine"
  keep_locally = true
}

resource "docker_container" "web" {
  name  = "afe-demo-terraform"
  image = docker_image.web.image_id
  # A site change appears in the plan and replaces the container on apply.
  env = ["AFE_DEMO_CONTENT_SHA=${filesha256("${path.module}/../site/index.html")}"]
  ports {
    internal = 8080
    external = var.port
    ip       = "127.0.0.1"
  }
  upload {
    file        = "/usr/share/nginx/html/index.html"
    content     = file("${path.module}/../site/index.html")
    permissions = "0644"
  }
}

output "url" {
  value = "http://127.0.0.1:${var.port}"
}
