import { NextRequest, NextResponse } from 'next/server';

/**
 * GET /api/download?platform=mac-apple-silicon|mac-intel|windows
 *
 * PUBLIC — no auth or subscription required.
 *
 * Immediately redirects (302) to the correct GitHub Release asset.
 * The browser follows the redirect and starts the file download directly.
 * No JSON is returned — plain <a href="/api/download?platform=..."> works.
 *
 * Usage inside the app remains gated by login + subscription + device checks.
 *
 * ── To update for a new release ──────────────────────────────────────────────
 * 1. Upload new assets to GitHub Releases with the names in PLATFORM_ASSETS.
 * 2. If using a versioned tag, set GITHUB_RELEASE_TAG env var.
 *    Omit it (or set to "latest") to always serve the most recent release.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const RELEASE = {
  owner: process.env.GITHUB_RELEASE_OWNER ?? 'NickyVHDP',
  repo:  process.env.GITHUB_RELEASE_REPO  ?? 'statflobot-releases',
  tag:   process.env.GITHUB_RELEASE_TAG   ?? 'latest',
} as const;

// Exact filenames as uploaded to GitHub Releases
const PLATFORM_ASSETS: Record<string, string> = {
  'mac-apple-silicon': 'StatfloBot-mac-apple-silicon.dmg',
  'mac-intel':         'StatfloBot-mac-intel.dmg',
  'windows':           'StatfloBot-windows.exe',
};

function buildGithubUrl(filename: string): string {
  const { owner, repo, tag } = RELEASE;
  if (tag === 'latest') {
    return `https://github.com/${owner}/${repo}/releases/latest/download/${filename}`;
  }
  return `https://github.com/${owner}/${repo}/releases/download/${tag}/${filename}`;
}

export async function GET(req: NextRequest) {
  const platform = req.nextUrl.searchParams.get('platform') ?? '';
  const assetName = PLATFORM_ASSETS[platform];

  if (!assetName) {
    return NextResponse.json(
      { error: 'Invalid platform. Use mac-apple-silicon, mac-intel, or windows.' },
      { status: 400 },
    );
  }

  // 302 redirect → browser follows it → GitHub serves the file → download starts.
  // No JSON page shown to the user.
  const downloadUrl = buildGithubUrl(assetName);
  return NextResponse.redirect(downloadUrl, { status: 302 });
}
