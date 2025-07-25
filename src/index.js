/**
 * Main Durable Object Class
 * This is the stateful background processor that handles the heavy lifting.
 */
export class ShotListDurableObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  // The fetch handler is the entry point for communications to the DO.
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/start') {
      this.ctx.waitUntil(this.processScript()); // Process in the background
      return new Response('Job accepted.', { status: 202 });
    }

    if (url.pathname === '/status') {
      const status = await this.ctx.storage.get('status');
      const response = status || { status: 'pending', detail: 'Job is queued for processing.' };
      return new Response(JSON.stringify(response), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response('Not Found in Durable Object', { status: 404 });
  }

  // This is the main background task. It runs without timeout.
  async processScript() {
    const jobId = this.ctx.id.name;

    try {
      await this.ctx.storage.put('status', { status: 'processing', progress: 0, total_scenes: 0 });

      const r2Object = await this.env.R2_BUCKET.get(jobId);
      if (!r2Object) throw new Error('Script not found in R2 for this job.');
      const fullScript = await r2Object.text();

      const sceneChunks = fullScript.split(/(?=^(INT\.|EXT\.)\s.*)/gm).filter(chunk => chunk.trim() !== '');
      await this.ctx.storage.put('status', { status: 'processing', progress: 0, total_scenes: sceneChunks.length });

      const successful_scenes = [];
      const failed_scenes = [];

      for (let i = 0; i < sceneChunks.length; i++) {
        const sceneText = sceneChunks[i];
        const sceneHeading = sceneText.split('\n')[0].trim();
        try {
          const aiResponse = await this.runAIForScene(sceneText);
          successful_scenes.push({ scene: sceneHeading, shot_list_data: aiResponse });
        } catch (e) {
          failed_scenes.push({ scene: sceneHeading, error: e.message });
        }
        await this.ctx.storage.put('status', { status: 'processing', progress: i + 1, total_scenes: sceneChunks.length });
      }

      await this.ctx.storage.put('status', { status: 'complete', results: { successful_scenes, failed_scenes } });
      await this.env.R2_BUCKET.delete(jobId);

    } catch (e) {
      await this.ctx.storage.put('status', { status: 'failed', reason: e.message });
      await this.env.R2_BUCKET.delete(jobId);
    }
  }

  async runAIForScene(sceneText) {
    const shotlistSchema = {
      type: 'object',
      properties: { shot_list: { type: 'array', items: { type: 'object', properties: { shot_description: { type: 'string' }, shot_size: { type: 'string' }, shot_type: { type: 'string' }, camera_movement: { type: 'string' }, equipment: { type: 'string' }, }, required: ['shot_description', 'shot_size', 'shot_type', 'camera_movement', 'equipment'] } } }, required: ['shot_list']
    };
    const inputs = {
      messages: [
        { role: 'system', content: 'You are a cinematographer\'s assistant. Analyze the provided film script scene and generate a detailed shot list based on the required JSON schema.' },
        { role: 'user', content: `Here is the film script scene: ${sceneText}` }
      ],
      response_format: { type: 'json_schema', json_schema: shotlistSchema }
    };
    return this.env.AI.run('@cf/meta/llama-3-8b-instruct', inputs);
  }
}

/**
 * Main Worker Router
 * This is the public-facing part of our service.
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathSegments = url.pathname.split('/').filter(Boolean);

    // Route: POST /process
    if (pathSegments[0] === 'process' && request.method === 'POST') {
      let script;
      try {
        const body = await request.json();
        script = body.script;
        if (!script || typeof script !== 'string') throw new Error();
      } catch (e) {
        return new Response(JSON.stringify({ error: 'Request body must be JSON with a "script" key.' }), { status: 400 });
      }

      const jobId = crypto.randomUUID();
      await env.R2_BUCKET.put(jobId, script);

      const doId = env.ShotListDurableObject.idFromName(jobId);
      const doStub = env.ShotListDurableObject.get(doId);

      // We don't wait, just kick off the DO
      doStub.fetch('https://do-internal/start');

      return new Response(JSON.stringify({ jobId }), { headers: { 'Content-Type': 'application/json' } });
    }

    // Route: GET /status/:jobId
    if (pathSegments[0] === 'status' && pathSegments[1]) {
      const jobId = pathSegments[1];
      const doId = env.ShotListDurableObject.idFromName(jobId);
      const doStub = env.ShotListDurableObject.get(doId);
      return doStub.fetch('https://do-internal/status');
    }

    const usage = `Welcome!
- To start a job, send a POST request to /process
- To check a job, send a GET request to /status/:jobId`;
    return new Response(usage, { status: 404 });
  }
};