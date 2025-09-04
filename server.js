const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Fix for Render proxy issues
app.set('trust proxy', 1);

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Rate limiting
const generateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20,
  message: {
    error: 'Rate limit exceeded. Please try again later.',
    type: 'rate_limit'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// User usage tracking
const userUsage = new Map();
const FREE_TIER_LIMIT = 50;

// Reset usage daily instead of monthly to avoid timeout issues
setInterval(() => {
  userUsage.clear();
}, 24 * 60 * 60 * 1000);

// Optimized system prompt for Supra Move
function buildOptimizedSystemPrompt() {
  return `You are a Supra Move compiler expert. Generate ONLY code that compiles without errors.

CRITICAL RULES (NEVER BREAK THESE):
1. Functions using borrow_global MUST have "acquires ResourceName"
2. Only import what you actually use - remove unused imports
3. Prefix unused parameters with underscore: _param
4. Use signer::address_of(account) NOT @0x1 for addresses
5. Use std::string::utf8() for string literals

EXACT WORKING TEMPLATE:
module your_address::module_name {
    use std::signer;
    use supra_framework::coin::{Self, BurnCapability, FreezeCapability, MintCapability};

    struct CoinType has key {}
    
    struct TokenCapabilities has key {
        mint_cap: MintCapability<CoinType>,
        burn_cap: BurnCapability<CoinType>,
        freeze_cap: FreezeCapability<CoinType>,
    }

    fun init_module(account: &signer) acquires TokenCapabilities {
        let addr = signer::address_of(account);
        let (burn_cap, freeze_cap, mint_cap) = coin::initialize<CoinType>(
            account,
            std::string::utf8(b"Token Name"),
            std::string::utf8(b"SYMBOL"),
            8,
            true,
        );
        move_to(account, TokenCapabilities { mint_cap, burn_cap, freeze_cap });
        
        // If initial mint requested:
        let caps = borrow_global<TokenCapabilities>(addr);
        let coins = coin::mint(amount_with_decimals, &caps.mint_cap);
        coin::deposit(addr, coins);
    }

    public entry fun mint(_admin: &signer, recipient: address, amount: u64) acquires TokenCapabilities {
        let caps = borrow_global<TokenCapabilities>(@your_address);
        let coins = coin::mint(amount, &caps.mint_cap);
        coin::deposit(recipient, coins);
    }

    #[view]
    public fun get_balance(account: address): u64 {
        coin::balance<CoinType>(account)
    }
}

NEVER generate code with compilation errors. Always use this exact pattern.`;
}

// Enhanced prompt builder
function buildEnhancedPrompt(prompt, context = {}) {
  const moduleName = context?.moduleName || 'custom_contract';
  let instructions = '';
  
  // Smart detection of requirements
  if (prompt.toLowerCase().includes('mint') && (prompt.includes('1000000') || prompt.includes('1 M'))) {
    instructions += '\n- Mint exactly 1,000,000 tokens (use: 100000000000000 for 8 decimals)';
  }
  
  if (prompt.toLowerCase().includes('deployer')) {
    instructions += '\n- Mint initial tokens to deployer address using signer::address_of(account)';
  }
  
  if (prompt.toLowerCase().includes('balance')) {
    instructions += '\n- Include get_balance view function';
  }

  return `Create a Supra Move smart contract: ${prompt}

Module name: ${moduleName}
${instructions}

Requirements:
- Use the exact template pattern provided
- Ensure ALL functions with borrow_global have acquires annotation
- Remove unused imports
- Make it compile without errors or warnings`;
}

// Optimized OpenAI call
async function callOpenAI(prompt, context) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OpenAI API key not configured');
  }

  const systemPrompt = buildOptimizedSystemPrompt();
  const enhancedPrompt = buildEnhancedPrompt(prompt, context);

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
          { role: 'system', content: systemPrompt },
          { role: 'user', content: enhancedPrompt }
        ],
        max_tokens: 2000,
        temperature: 0.3 // Lower temperature for more consistent code
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`OpenAI API error: ${errorData.error?.message || response.statusText}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;

  } catch (error) {
    console.error('OpenAI call failed:', error);
    throw error;
  }
}

// Code validation
function validateCode(code) {
  const issues = [];
  
  // Critical compilation checks
  if (code.includes('borrow_global') && !code.includes('acquires')) {
    issues.push('Missing acquires annotation');
  }
  
  if (code.includes('@0x1') && code.includes('signer::address_of')) {
    issues.push('Mixed address usage - use signer::address_of consistently');
  }
  
  return issues;
}

// Usage management
function checkUserUsage(userId) {
  const usage = userUsage.get(userId) || { count: 0, lastReset: new Date() };
  return usage;
}

function updateUserUsage(userId, usage) {
  usage.count += 1;
  userUsage.set(userId, usage);
}

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    service: 'supra-ai-optimized',
    version: '2.0.0',
    timestamp: new Date().toISOString()
  });
});

// Main generation endpoint
app.post('/v1/generate', generateLimiter, async (req, res) => {
  try {
    const { prompt, context = {}, userId } = req.body;

    // Validation
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({
        error: 'Missing or invalid prompt',
        type: 'validation_error'
      });
    }

    if (!userId) {
      return res.status(400).json({
        error: 'Missing user ID',
        type: 'validation_error'
      });
    }

    // Check usage limits
    const usage = checkUserUsage(userId);
    if (usage.count >= FREE_TIER_LIMIT) {
      return res.status(402).json({
        error: 'Free tier limit reached. Please upgrade.',
        type: 'usage_limit',
        currentUsage: usage.count,
        limit: FREE_TIER_LIMIT
      });
    }

    console.log(`Generating code for user ${userId}, usage: ${usage.count}/${FREE_TIER_LIMIT}`);

    // Generate code
    const generatedCode = await callOpenAI(prompt, context);
    
    // Validate generated code
    const issues = validateCode(generatedCode);
    if (issues.length > 0) {
      console.log('Validation issues:', issues);
      // Continue anyway but log for improvement
    }

    // Update usage
    updateUserUsage(userId, usage);

    console.log(`Code generated successfully for user ${userId}`);

    res.json({
      generatedCode,
      usage: {
        current: usage.count + 1,
        limit: FREE_TIER_LIMIT,
        remaining: FREE_TIER_LIMIT - (usage.count + 1)
      },
      validation: {
        issues: issues.length > 0 ? issues : null,
        status: issues.length === 0 ? 'clean' : 'warnings'
      },
      metadata: {
        timestamp: new Date().toISOString(),
        promptLength: prompt.length
      }
    });

  } catch (error) {
    console.error('Generation error:', error);

    if (error.message.includes('OpenAI API')) {
      res.status(503).json({
        error: 'AI service temporarily unavailable.',
        type: 'service_error'
      });
    } else {
      res.status(500).json({
        error: 'Generation failed. Please try again.',
        type: 'internal_error'
      });
    }
  }
});

// Usage stats
app.get('/v1/usage/:userId', (req, res) => {
  const { userId } = req.params;
  const usage = checkUserUsage(userId);
  
  res.json({
    current: usage.count,
    limit: FREE_TIER_LIMIT,
    remaining: Math.max(0, FREE_TIER_LIMIT - usage.count),
    resetInfo: 'Usage resets daily'
  });
});

// Pricing endpoint
app.get('/v1/pricing', (req, res) => {
  res.json({
    plans: [
      {
        name: 'Free',
        price: 0,
        generationsPerDay: FREE_TIER_LIMIT,
        features: ['Basic AI generation', 'Compilation validation']
      },
      {
        name: 'Pro',
        price: 29,
        generationsPerDay: 100,
        features: ['Advanced generation', 'Priority support', 'Custom templates']
      }
    ]
  });
});

// Error handling
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
  console.log(`Optimized Supra AI Service running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
