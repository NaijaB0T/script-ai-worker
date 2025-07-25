// Import unpdf for proper PDF text extraction
import { extractText, getDocumentProxy } from 'unpdf';

/**
 * Main Durable Object Class
 * This is the stateful background processor that handles the heavy lifting.
 */
export class ShotListDurableObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    console.log('DO Constructor - R2_BUCKET available:', !!env.R2_BUCKET);
    console.log('DO Constructor - AI available:', !!env.AI);
  }

  // The fetch handler is the entry point for communications to the DO.
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/start') {
      let jobData = null;
      if (request.method === 'POST') {
        try {
          jobData = await request.json();
        } catch (e) {
          // Fallback if no body
        }
      }
      this.ctx.waitUntil(this.processScript(jobData)); // Process in the background
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
  async processScript(jobData) {
    const doId = this.ctx.id.name;
    const r2Key = jobData?.r2Key || jobData?.jobId || doId;
    
    console.log('=== DURABLE OBJECT START ===');
    console.log('Durable Object ID:', doId);
    console.log('R2 key to use:', r2Key);
    console.log('JobData received:', !!jobData);
    console.log('JobData content:', JSON.stringify(jobData));
    console.log('R2_BUCKET available:', !!this.env.R2_BUCKET);
    console.log('AI available:', !!this.env.AI);

    try {
      await this.ctx.storage.put('status', { status: 'processing', progress: 0, total_scenes: 0 });

      console.log('=== R2 RETRIEVAL ATTEMPT ===');
      console.log('Attempting to fetch script from R2 with key:', r2Key);
      console.log('Full R2 bucket name:', this.env.R2_BUCKET?.name || 'unknown');
      
      let r2Object;
      let attempts = 0;
      const maxAttempts = 5;
      const baseDelay = 1000; // 1 second
      
      while (attempts < maxAttempts) {
        attempts++;
        console.log(`R2 retrieval attempt ${attempts}/${maxAttempts}`);
        
        try {
          r2Object = await this.env.R2_BUCKET.get(r2Key);
          console.log('R2 get operation completed');
          console.log('R2 object result:', !!r2Object);
          
          if (r2Object) {
            console.log('R2 object found successfully on attempt', attempts);
            break;
          }
          
          console.log(`R2 object not found on attempt ${attempts}, waiting before retry...`);
          
          if (attempts < maxAttempts) {
            // Exponential backoff: 1s, 2s, 4s, 8s
            const delay = baseDelay * Math.pow(2, attempts - 1);
            console.log(`Waiting ${delay}ms before retry...`);
            await new Promise(resolve => setTimeout(resolve, delay));
          }
          
        } catch (r2GetError) {
          console.error(`R2 get operation failed on attempt ${attempts}:`, r2GetError);
          if (attempts === maxAttempts) {
            console.error('R2 error name:', r2GetError.name);
            console.error('R2 error message:', r2GetError.message);
            console.error('R2 error stack:', r2GetError.stack);
            throw r2GetError;
          }
          // Wait before retrying on error too
          const delay = baseDelay * Math.pow(2, attempts - 1);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
      
      if (!r2Object) {
        console.error('=== R2 RETRIEVAL FAILED AFTER ALL ATTEMPTS ===');
        console.error('Script not found in R2 after', maxAttempts, 'attempts. R2 key used:', r2Key);
        console.error('Attempting to list some R2 objects for debugging...');
        
        try {
          const listResult = await this.env.R2_BUCKET.list({ limit: 10 });
          console.log('Recent R2 objects:', listResult.objects?.map(obj => obj.key) || []);
        } catch (listError) {
          console.error('Failed to list R2 objects:', listError);
        }
        
        throw new Error('Script not found in R2 for this job after multiple attempts.');
      }
      
      console.log('=== R2 TEXT EXTRACTION ===');
      const fullScript = await r2Object.text();
      console.log('Successfully fetched script from R2, length:', fullScript.length);
      console.log('Script preview (first 100 chars):', fullScript.substring(0, 100));

      // Improved scene splitting with multiple patterns
      let sceneChunks = [];
      
      // Try different scene splitting patterns
      if (fullScript.match(/^(INT\.|EXT\.)/gm)) {
        // Standard screenplay format
        sceneChunks = fullScript.split(/(?=^(INT\.|EXT\.)\s.*)/gm).filter(chunk => chunk.trim() !== '');
      } else if (fullScript.match(/^FADE IN:/gm) || fullScript.match(/SCENE \d+/gm)) {
        // Alternative formats
        sceneChunks = fullScript.split(/(?=^(FADE IN:|SCENE \d+|INTERIOR|EXTERIOR))/gm).filter(chunk => chunk.trim() !== '');
      } else {
        // If no scene markers found, treat as single scene but try to split by obvious breaks
        const paragraphs = fullScript.split(/\n\s*\n/).filter(p => p.trim() !== '');
        if (paragraphs.length > 1) {
          sceneChunks = paragraphs;
        } else {
          sceneChunks = [fullScript];
        }
      }
      
      console.log('Scene splitting results:');
      console.log('Total scenes found:', sceneChunks.length);
      console.log('First scene preview:', sceneChunks[0]?.substring(0, 100) + '...');
      
      await this.ctx.storage.put('status', { status: 'processing', progress: 0, total_scenes: sceneChunks.length });

      const successful_scenes = [];
      const failed_scenes = [];

      for (let i = 0; i < sceneChunks.length; i++) {
        const sceneText = sceneChunks[i];
        
        // Extract scene heading with better logic
        let sceneHeading = sceneText.split('\n')[0].trim();
        
        // If heading is too long, try to extract a proper scene heading
        if (sceneHeading.length > 100) {
          // Look for common scene heading patterns
          const headingMatch = sceneText.match(/^(INT\.|EXT\.|INTERIOR|EXTERIOR|SCENE \d+)[^\n]*/m);
          if (headingMatch) {
            sceneHeading = headingMatch[0].trim();
          } else {
            // Generate a generic heading based on scene number
            sceneHeading = `Scene ${i + 1}`;
          }
        }
        
        // Ensure heading is not too long (max 80 characters)
        if (sceneHeading.length > 80) {
          sceneHeading = sceneHeading.substring(0, 77) + '...';
        }
        
        console.log(`Processing scene ${i + 1}: "${sceneHeading}"`);
        console.log(`Scene text length: ${sceneText.length} characters`);
        try {
          const aiResponse = await this.runAIForScene(sceneText);
          
          // Use AI-generated scene location if available, otherwise fallback to parsed heading
          const finalSceneLocation = aiResponse?.response?.scene_location || sceneHeading;
          console.log(`AI-generated scene location: "${finalSceneLocation}"`);
          
          successful_scenes.push({ scene: finalSceneLocation, shot_list_data: aiResponse });
        } catch (e) {
          failed_scenes.push({ scene: sceneHeading, error: e.message });
        }
        await this.ctx.storage.put('status', { status: 'processing', progress: i + 1, total_scenes: sceneChunks.length });
      }

      await this.ctx.storage.put('status', { status: 'complete', results: { successful_scenes, failed_scenes } });
      await this.env.R2_BUCKET.delete(r2Key);

    } catch (e) {
      console.error('Error in processScript:', e.message);
      await this.ctx.storage.put('status', { status: 'failed', reason: e.message });
      try {
        await this.env.R2_BUCKET.delete(r2Key);
      } catch (cleanupError) {
        console.error('Error cleaning up R2 object:', cleanupError.message);
      }
    }
  }

  async runAIForScene(sceneText) {
    const shotlistSchema = {
      type: 'object',
      properties: { 
        scene_location: {
          type: 'string',
          description: 'The location/setting of this scene (e.g., "INT. COFFEE SHOP - DAY", "EXT. PARK - NIGHT", "Grace\'s Laptop Screen")'
        },
        shot_list: { 
          type: 'array', 
          items: { 
            type: 'object', 
            properties: { 
              shot_description: { 
                type: 'string',
                description: 'Brief description of what the camera shows in this specific shot (e.g., "Close-up of John\'s worried face", "Wide shot of the office building exterior")'
              }, 
              shot_size: { 
                type: 'string',
                enum: ['Extreme Wide Shot', 'Wide Shot', 'Medium Wide Shot', 'Medium Shot', 'Medium Close-up', 'Close-up', 'Extreme Close-up']
              }, 
              shot_type: { 
                type: 'string',
                enum: ['Master Shot', 'Coverage', 'Insert', 'Cutaway', 'Reaction Shot', 'POV Shot', 'Over-Shoulder']
              }, 
              camera_movement: { 
                type: 'string',
                enum: ['Static', 'Pan', 'Tilt', 'Zoom', 'Dolly', 'Tracking', 'Crane', 'Handheld', 'Steadicam']
              }, 
              equipment: { 
                type: 'string',
                enum: ['Camera', 'Tripod', 'Dolly', 'Crane', 'Steadicam', 'Handheld Rig', 'Slider', 'Jib']
              }
            }, 
            required: ['shot_description', 'shot_size', 'shot_type', 'camera_movement', 'equipment'] 
          } 
        } 
      }, 
      required: ['scene_location', 'shot_list']
    };
    
    const inputs = {
      messages: [
        { 
          role: 'system', 
          content: `You are a professional cinematographer creating a shot list. Your job is to break down a script scene into individual camera shots.

IMPORTANT: Each shot_description should be a brief, specific description of what the camera captures in that ONE shot - NOT the entire scene text.

Examples of GOOD shot descriptions:
- "Close-up of Anna's hands trembling as she reaches for the door"
- "Wide shot establishing the coffee shop interior"
- "Medium shot of Mark entering through the front door"
- "Over-shoulder shot from Anna's POV watching Mark approach"

Examples of BAD shot descriptions (DO NOT DO THIS):
- Copying the entire scene dialogue and action
- Describing multiple shots in one description
- Including the full script text`
        },
        { 
          role: 'user', 
          content: `Break down this script scene into individual camera shots. Create 3-8 distinct shots that would capture all the important moments and emotions in the scene.

ALSO: Extract the scene location/setting from the script and provide it in the scene_location field. This should be a concise description of where the scene takes place (e.g., "INT. COFFEE SHOP - DAY", "EXT. PARK - NIGHT", or "Grace's Laptop Screen").

Script scene:
${sceneText}

Remember: Each shot_description should describe ONE specific camera angle/framing, not the entire scene.` 
        }
      ],
      response_format: { type: 'json_schema', json_schema: shotlistSchema }
    };
    
    return this.env.AI.run('@cf/meta/llama-3-8b-instruct', inputs);
  }
}

// Proper PDF text extraction function using unpdf
async function extractTextFromPDF(pdfBuffer) {
  try {
    console.log('Starting PDF text extraction with unpdf...');
    console.log('PDF buffer type:', typeof pdfBuffer, 'length:', pdfBuffer?.length);
    
    // Validate PDF buffer
    if (!pdfBuffer || pdfBuffer.length === 0) {
      throw new Error('PDF buffer is empty');
    }
    
    // Check if it starts with PDF header
    const pdfHeader = new TextDecoder().decode(pdfBuffer.slice(0, 8));
    console.log('PDF header:', pdfHeader);
    
    if (!pdfHeader.startsWith('%PDF-')) {
      throw new Error('Invalid PDF header - not a valid PDF file');
    }
    
    // Use unpdf to extract text from the PDF buffer (following Cloudflare docs pattern)
    console.log('Getting document proxy with unpdf...');
    
    // Step 1: Get document proxy from PDF buffer
    const document = await getDocumentProxy(pdfBuffer);
    console.log('Document proxy created successfully');
    
    // Step 2: Extract text from the document
    console.log('Extracting text from document...');
    const result = await extractText(document, { mergePages: true });
    const extractedText = result.text;
    console.log('Text extraction completed');
    
    console.log('Extracted text type:', typeof extractedText);
    console.log('Extracted text length:', extractedText?.length || 0);
    console.log('First 100 chars:', extractedText?.substring(0, 100));
    
    if (!extractedText || extractedText.trim().length < 10) {
      throw new Error('No readable text found in PDF - may be image-based or encrypted');
    }
    
    // Clean up the extracted text
    const cleanedText = extractedText
      .replace(/\s+/g, ' ') // Replace multiple spaces with single space
      .replace(/\n\s*\n/g, '\n\n') // Clean up multiple newlines
      .trim();
    
    console.log('Successfully extracted and cleaned text from PDF');
    console.log('Final text length:', cleanedText.length);
    return cleanedText;
    
  } catch (error) {
    console.error('PDF text extraction error:', error.name, error.message);
    console.error('Error stack:', error.stack);
    throw new Error('Failed to extract text from PDF: ' + error.message);
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

    // Route: POST /process - Unified PDF upload and processing endpoint
    if (pathSegments[0] === 'process' && request.method === 'POST') {
      try {
        console.log('=== UNIFIED PROCESS ENDPOINT ===');
        console.log('Content-Type:', request.headers.get('Content-Type'));
        
        let extractedText;
        const jobId = crypto.randomUUID();
        console.log('Generated jobId:', jobId);

        // Check if this is a PDF file upload (multipart/form-data) or text input (JSON)
        const contentType = request.headers.get('Content-Type') || '';
        
        if (contentType.includes('multipart/form-data')) {
          // Handle PDF file upload
          console.log('Processing PDF file upload...');
          
          const formData = await request.formData();
          const pdfFile = formData.get('pdfFile');
          
          if (!pdfFile) {
            return new Response(JSON.stringify({ error: 'PDF file is required' }), { 
              status: 400,
              headers: { 'Content-Type': 'application/json' }
            });
          }

          console.log('PDF file received:', pdfFile.name, 'size:', pdfFile.size);
          
          // Extract text from PDF immediately
          const pdfBuffer = await pdfFile.arrayBuffer();
          const uint8Array = new Uint8Array(pdfBuffer);
          
          console.log('Extracting text from PDF...');
          extractedText = await extractTextFromPDF(uint8Array);
          console.log('Text extraction completed, length:', extractedText.length);
          
        } else {
          // Handle text input (backward compatibility)
          console.log('Processing text input...');
          
          const body = await request.json();
          extractedText = body.script;
          
          if (!extractedText || typeof extractedText !== 'string') {
            return new Response(JSON.stringify({ error: 'Script text is required' }), { 
              status: 400,
              headers: { 'Content-Type': 'application/json' }
            });
          }
          console.log('Text input received, length:', extractedText.length);
        }

        // Store the extracted text in R2 for processing
        console.log('Storing script text in R2 with key:', jobId);
        console.log('Script text length:', extractedText.length);
        await env.R2_BUCKET.put(jobId, extractedText);
        console.log('Script stored in R2 successfully');
        
        // Verify storage immediately
        console.log('Verifying R2 storage immediately...');
        const verifyObject = await env.R2_BUCKET.get(jobId);
        if (!verifyObject) {
          console.error('CRITICAL: Script not found in R2 immediately after storage!');
          throw new Error('Failed to store script in R2');
        }
        console.log('R2 storage verification successful');

        // Start the Durable Object processing
        const doId = env.SHOT_LIST_DO.idFromName(jobId);
        const doStub = env.SHOT_LIST_DO.get(doId);
        console.log('Starting Durable Object processing with jobId:', jobId);
        console.log('Durable Object ID created from jobId:', doId.toString());

        const doRequest = new Request('https://do-internal/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            jobId: jobId,
            r2Key: jobId,
            timestamp: Date.now()
          })
        });
        
        await doStub.fetch(doRequest);
        console.log('Durable Object started successfully');

        return new Response(JSON.stringify({ jobId }), { 
          headers: { 'Content-Type': 'application/json' } 
        });

      } catch (error) {
        console.error('Process endpoint error:', error);
        return new Response(JSON.stringify({ 
          error: 'Failed to process request: ' + error.message 
        }), { 
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // Route: GET /status/:jobId
    if (pathSegments[0] === 'status' && pathSegments[1]) {
      const jobId = pathSegments[1];
      const doId = env.SHOT_LIST_DO.idFromName(jobId);
      const doStub = env.SHOT_LIST_DO.get(doId);
      return doStub.fetch('https://do-internal/status');
    }


    const usage = `Welcome!
- To start a job, send a POST request to /process
- To check a job, send a GET request to /status/:jobId`;
    return new Response(usage, { status: 404 });
  }
};