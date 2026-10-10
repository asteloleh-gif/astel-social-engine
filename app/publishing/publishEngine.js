const crypto = require("crypto");
const { createPublishJob, PUBLISH_STATUS } = require("./publishState");

function createPublishEngine({
  providerRegistry,
  repository,
  enabled = false,
  dryRun = true,
  pollIntervalMs = 5_000,
  batchSize = 5,
  leaseMs = 60_000,
  now = () => new Date(),
  beforeProcess = null,
  beforeMutation = null,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) {
  if (!providerRegistry || typeof providerRegistry.findForAccount !== "function") {
    throw new Error("Publish engine requires provider registry");
  }
  if (!repository) throw new Error("Publish engine requires repository");

  let timer = null;
  let running = false;
  let lastRunAt = null;
  let lastResult = null;
  let lastError = null;

  function providerFor(accountKey) {
    return providerRegistry.findForAccount(accountKey);
  }

  function assertPublishCapability(provider) {
    if (!provider) throw new Error("Publish provider not found");
    if (!provider.capabilities?.publishPosts || typeof provider.publishPost !== "function") {
      throw new Error(`Provider ${provider.platform || "unknown"} does not support publishPosts`);
    }
    return provider;
  }

  async function enqueue(input = {}) {
    const provider = assertPublishCapability(providerFor(String(input.accountKey || "").toLowerCase()));
    const job = createPublishJob(input);
    const stored = await repository.enqueue(job);
    return { ...stored, job, provider: provider.platform };
  }

  async function getJob(id) {
    if (!id) return null;
    if (!repository.isReady?.()) throw new Error("Publish repository unavailable");
    return repository.get(id);
  }

  async function processJob(id) {
    if (!enabled) return { id, status: "skipped", reason: "PUBLISH_ENGINE_DISABLED" };
    const claimToken = crypto.randomUUID();
    const claimed = await repository.claim(id, claimToken, { now: now(), leaseMs });
    if (!claimed) return { id, status: "skipped", reason: "CLAIM_REJECTED" };

    const job = await repository.get(id);
    if (!job) {
      await repository.finish(id, claimToken, PUBLISH_STATUS.AMBIGUOUS_HOLD, { errorCode: "JOB_DISAPPEARED", now: now() });
      return { id, status: "ambiguous", reason: "JOB_DISAPPEARED" };
    }

    const provider = providerFor(job.accountKey);
    if (!provider) {
      await repository.finish(id, claimToken, PUBLISH_STATUS.FAILED, { errorCode: "PROVIDER_NOT_FOUND", now: now() });
      return { id, status: "failed", reason: "PROVIDER_NOT_FOUND" };
    }
    if (!provider.capabilities?.publishPosts || typeof provider.publishPost !== "function") {
      await repository.finish(id, claimToken, PUBLISH_STATUS.FAILED, { errorCode: "PUBLISH_POSTS_UNSUPPORTED", now: now() });
      return { id, status: "failed", reason: "PUBLISH_POSTS_UNSUPPORTED" };
    }
    if (provider.account?.enabled === false) {
      await repository.finish(id, claimToken, PUBLISH_STATUS.FAILED, { errorCode: "ACCOUNT_DISABLED", now: now() });
      return { id, status: "failed", reason: "ACCOUNT_DISABLED" };
    }
    if (provider.health?.().configured === false) {
      await repository.finish(id, claimToken, PUBLISH_STATUS.FAILED, { errorCode: "PROVIDER_NOT_CONFIGURED", now: now() });
      return { id, status: "failed", reason: "PROVIDER_NOT_CONFIGURED" };
    }

    if (beforeProcess) {
      try { await beforeProcess(job); }
      catch (error) {
        const reason = /^[A-Z0-9_]+$/.test(error?.message || "") ? error.message : "PUBLISH_PRECHECK_REJECTED";
        await repository.finish(id, claimToken, PUBLISH_STATUS.FAILED, { errorCode: reason, now: now() });
        return { id, status: "failed", reason };
      }
    }
    if (dryRun || provider.account?.dryRun === true || job.metadata?.deliveryMode === "Simulation") {
      const result = { wouldPublish: true, platform: provider.platform, contentType: job.content?.type || null };
      const committed = await repository.finish(id, claimToken, PUBLISH_STATUS.SIMULATED, { result, now: now() });
      return committed
        ? { id, status: "simulated", result }
        : { id, status: "ambiguous", reason: "SIMULATION_COMMIT_REJECTED" };
    }

    let publishResult;
    try {
      publishResult = await provider.publishPost(job.content, {
        jobId: job.id,
        scheduledAt: job.scheduledAt,
        metadata: job.metadata,
        beforeMutation: beforeMutation ? () => beforeMutation(job, claimToken) : undefined,
        checkpoint: repository.checkpoint ? patch => repository.checkpoint(id, claimToken, patch) : undefined,
      });
    } catch (error) {
      await repository.finish(id, claimToken, PUBLISH_STATUS.AMBIGUOUS_HOLD, {
        errorCode: "UNEXPECTED_PUBLISH_EXCEPTION",
        result: { message: error?.message || String(error) },
        now: now(),
      });
      return { id, status: "ambiguous", reason: "UNEXPECTED_PUBLISH_EXCEPTION" };
    }

    if (publishResult?.status === "published" && publishResult.id) {
      const committed = await repository.finish(id, claimToken, PUBLISH_STATUS.PUBLISHED, {
        result: { ...publishResult, id: String(publishResult.id), platform: provider.platform },
        now: now(),
      });
      return committed
        ? { id, status: "published", publishedId: String(publishResult.id) }
        : { id, status: "ambiguous", reason: "PUBLISH_STATE_COMMIT_REJECTED" };
    }

    if (publishResult?.status === "ambiguous") {
      await repository.finish(id, claimToken, PUBLISH_STATUS.AMBIGUOUS_HOLD, {
        errorCode: publishResult.reason || "AMBIGUOUS_PUBLISH",
        result: publishResult,
        now: now(),
      });
      return { id, status: "ambiguous", reason: publishResult.reason || "AMBIGUOUS_PUBLISH" };
    }

    await repository.finish(id, claimToken, PUBLISH_STATUS.FAILED, {
      errorCode: publishResult?.reason || "DEFINITIVE_PUBLISH_FAILURE",
      result: publishResult || {},
      now: now(),
    });
    return { id, status: "failed", reason: publishResult?.reason || "DEFINITIVE_PUBLISH_FAILURE" };
  }

  async function tick() {
    if (!enabled) return { status: "skipped", reason: "PUBLISH_ENGINE_DISABLED", processed: 0 };
    if (running) return { status: "skipped", reason: "PUBLISH_ENGINE_BUSY", processed: 0 };
    if (!repository.isReady?.()) return { status: "skipped", reason: "PUBLISH_REPOSITORY_UNAVAILABLE", processed: 0 };

    running = true;
    lastRunAt = now().toISOString();
    lastError = null;
    try {
      const recovered = await repository.recoverExpired(now());
      const ids = await repository.due(now(), batchSize);
      const results = [];
      for (const id of ids) results.push(await processJob(id));
      lastResult = { status: "ok", recoveredToHold: recovered, processed: results.length, results };
      return lastResult;
    } catch (error) {
      lastError = error?.message || String(error);
      lastResult = { status: "error", processed: 0, error: lastError };
      return lastResult;
    } finally {
      running = false;
    }
  }

  async function start() {
    if (!enabled) return { status: "skipped", reason: "PUBLISH_ENGINE_DISABLED" };
    if (!repository.isReady?.()) await repository.init();
    if (timer) return { status: "ok", reason: "ALREADY_RUNNING" };
    timer = setIntervalImpl(() => {
      tick().catch(error => { lastError = error?.message || String(error); });
    }, Math.max(1_000, Number(pollIntervalMs) || 5_000));
    timer?.unref?.();
    return { status: "ok", reason: "STARTED" };
  }

  async function stop() {
    if (timer) clearIntervalImpl(timer);
    timer = null;
    return { status: "ok", reason: "STOPPED" };
  }

  function health() {
    return {
      enabled: Boolean(enabled),
      dryRun: Boolean(dryRun),
      running,
      schedulerActive: Boolean(timer),
      pollIntervalMs: Math.max(1_000, Number(pollIntervalMs) || 5_000),
      batchSize: Math.max(1, Number(batchSize) || 5),
      leaseMs: Math.max(1_000, Number(leaseMs) || 60_000),
      repository: repository.health?.() || null,
      lastRunAt,
      lastResult,
      lastError,
    };
  }

  return { enqueue, getJob, processJob, tick, start, stop, health };
}

module.exports = { createPublishEngine };
