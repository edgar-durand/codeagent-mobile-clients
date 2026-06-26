package com.windsurf.controller.services

private const val LEARN_MORE_URL = "https://www.codeagent-mobile.com/docs/network"

data class CloudFallbackMessage(
    val title: String,
    val body: String,
    val steps: List<String>,
    val repoLine: String?,
    val learnMoreUrl: String,
)

fun buildCloudFallbackMessage(repo: RepoSlug?, branch: String?): CloudFallbackMessage {
    val repoLine = if (repo != null) {
        "${repo.owner}/${repo.repo}" + (branch?.let { " · $it" } ?: "")
    } else {
        null
    }
    val pickStep = if (repo != null) {
        "Pick this repo: ${repo.owner}/${repo.repo}"
    } else {
        "Pick this repository"
    }
    return CloudFallbackMessage(
        title = "Can't reach CodeAgent on this network",
        body = "Your network (VPN or firewall) is blocking the connection to CodeAgent. " +
            "You can still drive this project from your phone using a cloud workspace — " +
            "it runs on GitHub, so your machine's network restrictions don't apply.",
        steps = listOf(
            "Open the CodeAgent app on your phone",
            "Start a cloud workspace (Deploy → New Codespace)",
            pickStep,
            "Drive the agent from your phone",
        ),
        repoLine = repoLine,
        learnMoreUrl = LEARN_MORE_URL,
    )
}
