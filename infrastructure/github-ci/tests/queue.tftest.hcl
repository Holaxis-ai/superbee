mock_provider "github" {}

run "disabled_until_ready" {
  command = plan
  assert {
    condition     = github_repository_ruleset.superbee_merge_queue.enforcement == "disabled"
    error_message = "Queue enforcement must be opt-in after main-branch readiness."
  }
  assert {
    condition     = github_repository_ruleset.superbee_merge_queue.repository == "superbee" && github_repository_ruleset.superbee_merge_queue.target == "branch"
    error_message = "Only the engine branch ruleset is managed by this root."
  }
  assert {
    condition     = toset(github_repository_ruleset.superbee_merge_queue.conditions[0].ref_name[0].include) == toset(["refs/heads/main"]) && length(github_repository_ruleset.superbee_merge_queue.conditions[0].ref_name[0].exclude) == 0
    error_message = "Only main may be targeted."
  }
  assert {
    condition     = length(github_repository_ruleset.superbee_merge_queue.bypass_actors) == 0
    error_message = "No actor may bypass this queue rule."
  }
}

run "authorized_activation" {
  command = plan
  variables {
    activate_merge_queue = true
  }
  assert {
    condition     = github_repository_ruleset.superbee_merge_queue.enforcement == "active"
    error_message = "Explicit activation enables queue enforcement."
  }
  assert {
    condition     = github_repository_ruleset.superbee_merge_queue.rules[0].merge_queue[0].grouping_strategy == "ALLGREEN" && github_repository_ruleset.superbee_merge_queue.rules[0].merge_queue[0].merge_method == "SQUASH" && github_repository_ruleset.superbee_merge_queue.rules[0].merge_queue[0].max_entries_to_merge == 1 && github_repository_ruleset.superbee_merge_queue.rules[0].merge_queue[0].max_entries_to_build == 2 && github_repository_ruleset.superbee_merge_queue.rules[0].merge_queue[0].check_response_timeout_minutes == 60
    error_message = "Preserve bounded all-green queue validation."
  }
  assert {
    condition     = one(github_repository_ruleset.superbee_merge_queue.rules[0].required_status_checks[0].required_check).context == "CI required lanes" && one(github_repository_ruleset.superbee_merge_queue.rules[0].required_status_checks[0].required_check).integration_id == 15368
    error_message = "Require the exact Actions-owned aggregate status."
  }
}
