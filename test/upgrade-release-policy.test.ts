import { describe, expect, test } from 'bun:test';
import {
  UPGRADE_RELEASE_POLICY,
  resolveReleasePublicationPolicy,
  resolveUpgradeReleasePolicy,
} from '../src/core/upgrade-release-policy.ts';

describe('old-binary upgrade release policy', () => {
  test('current supervised target is denied to silent/inline upgrade', () => {
    expect(UPGRADE_RELEASE_POLICY.supervised_staged_floor).toBe('0.42.59.0');
    expect(resolveUpgradeReleasePolicy('0.42.59.0')).toMatchObject({
      inlineAllowed: false,
      requiresSupervisedStagedRelease: true,
    });
  });

  test('unknown future targets fail closed until this binary explicitly approves one', () => {
    for (const target of ['0.42.60.0', '0.43.0.0', '1.0.0.0']) {
      expect(resolveUpgradeReleasePolicy(target)).toMatchObject({
        inlineAllowed: false,
        requiresSupervisedStagedRelease: true,
      });
    }
  });

  test('malformed targets fail closed and pre-boundary targets retain legacy inline behavior', () => {
    expect(resolveUpgradeReleasePolicy('not-a-release').inlineAllowed).toBe(false);
    expect(resolveUpgradeReleasePolicy('0.42.58.0')).toMatchObject({
      inlineAllowed: true,
      requiresSupervisedStagedRelease: false,
    });
  });

  test('supervised and unknown future targets stay out of normal latest', () => {
    expect(UPGRADE_RELEASE_POLICY.normal_latest_max_exclusive).toBe('0.42.59.0');
    for (const target of ['0.42.59.0', '0.42.60.0', '1.0.0.0']) {
      expect(resolveReleasePublicationPolicy(target)).toMatchObject({
        channel: 'prerelease',
        prerelease: true,
        makeLatest: false,
      });
    }
    expect(resolveReleasePublicationPolicy('not-a-release')).toBeNull();
  });
});
