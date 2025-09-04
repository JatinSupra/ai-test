const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { createHash } = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.set('trust proxy', 1);
app.use(cors());

// Rate limiting - 20 requests per hour per IP
const generateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20,
  message: {
    error: 'Rate limit exceeded. Please try again later or contact support for higher limits.',
    type: 'rate_limit'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// User usage tracking (in production, use a database)
const userUsage = new Map();
const FREE_TIER_LIMIT = 10;

// Reset user usage monthly
setInterval(() => {
  userUsage.clear();
}, 30 * 24 * 60 * 60 * 1000); // 30 days

async function callOpenAI(prompt, mcpKnowledge, context) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OpenAI API key not configured on server');
  }

  const systemPrompt = buildSystemPrompt(mcpKnowledge);
  const enhancedPrompt = buildEnhancedPrompt(prompt, mcpKnowledge, context);

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [
          {
            role: 'system',
            content: systemPrompt
          },
          {
            role: 'user',
            content: enhancedPrompt
          }
        ],
        max_tokens: 3000,
        temperature: 0.7
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`OpenAI API error: ${errorData.error?.message || response.statusText}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;

  } catch (error) {
    console.error('OpenAI API call failed:', error);
    throw error;
  }
}

function buildSystemPrompt(mcpKnowledge) {
  return `You are a Supra Move expert. Generate ONLY Supra-specific Move code using this EXACT syntax:

MANDATORY MODULE FORMAT:
module your_address::module_name {
    // imports here
}

MANDATORY IMPORTS (use these EXACTLY):
    use std::signer;
    use std::error;  
    use std::string::{Self, String};
    use supra_framework::coin::{Self, BurnCapability, FreezeCapability, MintCapability};
    use supra_framework::event;
    use supra_framework::timestamp;

FORBIDDEN:
- Do NOT use "address 0x1"
- Do NOT use "0x1::" imports  
- Do NOT use "resource struct"
- Do NOT use old Move syntax

REQUIRED:
- Use "module your_address::name {}"
- Use "supra_framework::" for all framework imports
- Use proper coin capabilities pattern
- Include init_module function
- Use #[view] for read functions

Generate modern Supra Move code that compiles without errors.`;
}

function buildEnhancedPrompt(prompt, mcpKnowledge, context = {}) {
  const moduleName = (context && context.moduleName) || 'custom_contract';
  const features = (context && Array.isArray(context.features)) ? context.features.join(', ') : 'basic functionality';
  
  return `Generate a Supra Move smart contract: ${prompt}

REQUIREMENTS:
- Module name: ${moduleName}
- Features needed: ${features}
- Use only verified modules from the knowledge base
- Include proper init_module function
- Add comprehensive error handling
- Emit events for important operations
- Include view functions for reading state
- Follow Supra-specific patterns exactly

VALIDATION CHECKLIST:
✓ Use supra_framework:: imports only
✓ No duplicate imports
✓ Proper coin registration checks
✓ Correct burn/mint patterns
✓ Handle Option types for supply
✓ Include proper error codes
✓ Add event emissions

Make it production-ready with proper validation, events, and error handling.`;
}

function checkUserUsage(userId) {
  const usage = userUsage.get(userId) || { count: 0, lastReset: new Date() };
  
  // Reset if it's been more than 30 days
  const now = new Date();
  const daysSinceReset = (now - usage.lastReset) / (1000 * 60 * 60 * 24);
  
  if (daysSinceReset >= 30) {
    usage.count = 0;
    usage.lastReset = now;
  }
  
  return usage;
}

function updateUserUsage(userId, usage) {
  usage.count += 1;
  userUsage.set(userId, usage);
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    service: 'supra-ai-service',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// Main generation endpoint
app.post('/v1/generate', generateLimiter, async (req, res) => {
  try {
    const { prompt, mcpKnowledge, context, userId, extensionVersion } = req.body;

    // Validate required fields
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({
        error: 'Missing or invalid prompt',
        type: 'validation_error'
      });
    }

    if (!userId || typeof userId !== 'string') {
      return res.status(400).json({
        error: 'Missing user ID',
        type: 'validation_error'
      });
    }

    // Check user usage limits
    const usage = checkUserUsage(userId);
    if (usage.count >= FREE_TIER_LIMIT) {
      return res.status(402).json({
        error: 'Free tier limit reached. Please upgrade your plan or contact support.',
        type: 'usage_limit',
        currentUsage: usage.count,
        limit: FREE_TIER_LIMIT
      });
    }

    console.log(`Generating code for user ${userId}, usage: ${usage.count}/${FREE_TIER_LIMIT}`);

    // Generate code using OpenAI
    const generatedCode = await callOpenAI(prompt, mcpKnowledge, context);

    // Update usage
    updateUserUsage(userId, usage);

    // Log successful generation
    console.log(`Code generated successfully for user ${userId}, new usage: ${usage.count + 1}/${FREE_TIER_LIMIT}`);

    res.json({
      generatedCode,
      usage: {
        current: usage.count + 1,
        limit: FREE_TIER_LIMIT,
        remaining: FREE_TIER_LIMIT - (usage.count + 1)
      },
      metadata: {
        timestamp: new Date().toISOString(),
        extensionVersion,
        promptLength: prompt.length
      }
    });

  } catch (error) {
    console.error('Generation error:', error);

    // Handle different types of errors
    if (error.message.includes('OpenAI API')) {
      res.status(503).json({
        error: 'AI service temporarily unavailable. Please try again.',
        type: 'service_error'
      });
    } else if (error.message.includes('rate limit')) {
      res.status(429).json({
        error: 'Rate limit exceeded on AI service. Please try again later.',
        type: 'rate_limit'
      });
    } else {
      res.status(500).json({
        error: 'Internal server error. Please contact support if this persists.',
        type: 'internal_error'
      });
    }
  }
});

// Usage stats endpoint
app.get('/v1/usage/:userId', (req, res) => {
  const { userId } = req.params;
  const usage = checkUserUsage(userId);
  
  res.json({
    current: usage.count,
    limit: FREE_TIER_LIMIT,
    remaining: Math.max(0, FREE_TIER_LIMIT - usage.count),
    resetDate: new Date(usage.lastReset.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString()
  });
});

// Pricing info endpoint
app.get('/v1/pricing', (req, res) => {
  res.json({
    plans: [
      {
        name: 'Free',
        price: 0,
        generationsPerMonth: FREE_TIER_LIMIT,
        features: ['Basic AI generation', 'Community support']
      },
      {
        name: 'Pro',
        price: 29,
        generationsPerMonth: 500,
        features: ['Advanced AI generation', 'Priority support', 'Custom templates']
      },
      {
        name: 'Enterprise',
        price: 199,
        generationsPerMonth: 'unlimited',
        features: ['Unlimited generations', 'Dedicated support', 'Custom integrations', 'SLA guarantee']
      }
    ]
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({
    error: 'Internal server error',
    type: 'internal_error'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    type: 'not_found'
  });
});

app.listen(PORT, () => {
  console.log(`Supra AI Service running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
