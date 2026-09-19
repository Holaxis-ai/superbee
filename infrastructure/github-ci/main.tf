terraform {
  required_version = "~> 1.16.0"
  required_providers {
    github = {
      source  = "integrations/github"
      version = "6.13.0"
    }
  }
  backend "s3" {}
}

provider "github" {
  owner = "Holaxis-ai"
}

variable "activate_merge_queue" {
  description = "Activate only after the reviewed workflows are on main and the read-only preflight succeeds."
  type        = bool
  default     = false
}

# This root owns only this additive rule. Existing branch protection and release
# tag rules keep their current owners; neither Windows nor hosted is managed here.
resource "github_repository_ruleset" "superbee_merge_queue" {
  name        = "Superbee merge queue"
  repository  = "superbee"
  target      = "branch"
  enforcement = var.activate_merge_queue ? "active" : "disabled"

  conditions {
    ref_name {
      include = ["refs/heads/main"]
      exclude = []
    }
  }

  rules {
    merge_queue {
      check_response_timeout_minutes    = 60
      grouping_strategy                 = "ALLGREEN"
      max_entries_to_build              = 2
      max_entries_to_merge              = 1
      merge_method                      = "SQUASH"
      min_entries_to_merge              = 1
      min_entries_to_merge_wait_minutes = 0
    }
    required_status_checks {
      strict_required_status_checks_policy = false
      do_not_enforce_on_create             = false
      required_check {
        context        = "CI required lanes"
        integration_id = 15368
      }
    }
  }

  lifecycle {
    prevent_destroy = true
  }
}

output "ruleset_id" {
  value = github_repository_ruleset.superbee_merge_queue.id
}
