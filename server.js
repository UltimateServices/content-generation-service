const express = require('express')
const cors = require('cors')
const { createClient } = require('@supabase/supabase-js')
const AnthropicSDK = require('@anthropic-ai/sdk')

const app = express()
app.use(cors())
app.use(express.json())

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const anthropic = new AnthropicSDK.Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
})

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Content Generation Service' })
})

// Main research endpoint
app.post('/research', async (req, res) => {
  const { cityId } = req.body

  if (!cityId) {
    return res.status(400).json({ error: 'City ID required' })
  }

  console.log(`🚀 Starting research for city ${cityId}`)

  try {
    const { data: city, error: cityError } = await supabase
      .from('cities')
      .select('*')
      .eq('id', cityId)
      .single()

    if (cityError || !city) {
      return res.status(404).json({ error: 'City not found' })
    }

    console.log(`📍 City: ${city.city}, ${city.state_code}`)

    const { data: job, error: jobError } = await supabase
      .from('research_jobs')
      .insert({
        city_id: cityId,
        status: 'processing',
        progress: 0,
        current_step: 'Starting...',
        started_at: new Date().toISOString(),
        results_json: { sections: {} }
      })
      .select()
      .single()

    if (jobError) {
      return res.status(500).json({ error: 'Failed to create job' })
    }

    const jobId = job.id
    console.log(`✅ Job created: ${jobId}`)

    // Start generation in background (doesn't block response)
    generateContent(jobId, cityId, city).catch(err => {
      console.error('❌ Generation failed:', err)
      supabase.from('research_jobs').update({
        status: 'failed',
        error_message: err.message,
        completed_at: new Date().toISOString()
      }).eq('id', jobId)
    })

    // Return immediately
    res.json({
      success: true,
      jobId,
      message: 'Content generation started'
    })

  } catch (error) {
    console.error('❌ Error:', error)
    res.status(500).json({ error: error.message })
  }
})

async function generateContent(jobId, cityId, city) {
  console.log(`🎨 Starting content generation for job ${jobId}`)

  const updateProgress = async (progress, step) => {
    await supabase.from('research_jobs').update({
      progress: Math.round(progress),
      current_step: step
    }).eq('id', jobId)
  }

  const neighborhoods = ['Downtown', 'Northside', 'Westside', 'Eastside']
  const sections = {}

  try {
    // Main page sections
    const mainSections = [
      { key: 'hero_services', label: 'Hero & Services', progress: 5, tokens: 3000 },
      { key: 'areas_whychoose', label: 'Areas & Why Choose Us', progress: 15, tokens: 2500 },
      { key: 'pricing_process', label: 'Pricing & Process', progress: 25, tokens: 2000 },
      { key: 'faqs_part1', label: 'FAQs Part 1', progress: 35, tokens: 2500 },
      { key: 'faqs_part2', label: 'FAQs Part 2', progress: 45, tokens: 2500 },
      { key: 'testimonials_cta', label: 'Testimonials & CTA', progress: 50, tokens: 1500 }
    ]

    sections.main = {}

    for (const section of mainSections) {
      await updateProgress(section.progress, `Main page: ${section.label}...`)
      console.log(`📝 Generating ${section.key}...`)
      
      const content = await generateMainSection(city, section.key, section.tokens)
      sections.main[section.key] = content
      
      console.log(`✅ ${section.key} complete (${content.wordCount} words)`)
    }

    // Neighborhood pages
    const neighborhoodSections = [
      { key: 'intro_projects', label: 'Intro & Projects', tokens: 2000 },
      { key: 'service_details', label: 'Service Details', tokens: 1500 },
      { key: 'faqs_cta', label: 'FAQs & CTA', tokens: 2000 }
    ]

    const baseProgress = 50
    const progressPerNeighborhood = 12.5

    for (let i = 0; i < neighborhoods.length; i++) {
      const neighborhood = neighborhoods[i]
      const neighborhoodProgress = baseProgress + (i * progressPerNeighborhood)
      
      const key = `neighborhood_${neighborhood}`
      sections[key] = {}

      for (let j = 0; j < neighborhoodSections.length; j++) {
        const section = neighborhoodSections[j]
        const sectionProgress = neighborhoodProgress + (j * (progressPerNeighborhood / 3))
        
        await updateProgress(sectionProgress, `${neighborhood}: ${section.label}...`)
        console.log(`📝 Generating ${neighborhood} - ${section.key}...`)
        
        const content = await generateNeighborhoodSection(city, neighborhood, section.key, section.tokens)
        sections[key][section.key] = content
        
        console.log(`✅ ${neighborhood} - ${section.key} (${content.wordCount} words)`)
      }
    }

    // Assemble pages
    await updateProgress(95, 'Assembling pages...')
    const pages = assemblePagesFromSections(city, neighborhoods, sections)

    // Save results
    await supabase.from('research_jobs').update({
      status: 'completed',
      progress: 100,
      current_step: 'Complete!',
      completed_at: new Date().toISOString(),
      results_json: { pages, sections }
    }).eq('id', jobId)

    console.log(`🎉 Job ${jobId} complete! Generated ${pages.length} pages.`)

  } catch (error) {
    console.error(`❌ Job ${jobId} failed:`, error)
    throw error
  }
}

async function generateMainSection(city, section, maxTokens) {
  const cityName = city.city
  const state = city.state_code
  
  const prompts = {
    hero_services: `Write EXACTLY 1,200 words for a dumpster rental landing page in ${cityName}, ${state}.

Include:
1. Compelling hero section (3 paragraphs) emphasizing local expertise
2. Comprehensive service breakdown (5-6 paragraphs): residential, commercial, construction, roofing, renovation, special waste

Return ONLY valid JSON:
{"content": "the full 1,200 word text", "wordCount": 1200}`,

    areas_whychoose: `Write EXACTLY 1,000 words about service areas and value proposition for ${cityName}, ${state}.

Include:
1. Service Areas (2-3 paragraphs): List 4-6 real neighborhoods in ${cityName}
2. Why Choose Us (3-4 paragraphs): local knowledge, fast delivery, transparent pricing, professional service

Return ONLY valid JSON:
{"content": "the full 1,000 word text", "neighborhoods": ["Area1", "Area2", "Area3", "Area4", "Area5", "Area6"], "wordCount": 1000}`,

    pricing_process: `Write EXACTLY 700 words about pricing and process for ${cityName}, ${state}.

Include pricing guide (2 paragraphs) and how it works (3 paragraphs).

Return ONLY valid JSON:
{"content": "the full 700 word text", "wordCount": 700}`,

    faqs_part1: `Write EXACTLY 10 FAQs with detailed answers (total 1,000 words) for ${cityName}, ${state}.

Topics: cost, permits, regulations, rental duration, pricing, fees, sizes, delivery speed, extensions, discounts

Each answer 80-120 words.

Return ONLY valid JSON:
{"faqs": [{"question": "...", "answer": "..."}], "wordCount": 1000}`,

    faqs_part2: `Write EXACTLY 10 FAQs with detailed answers (total 1,000 words) for ${cityName}, ${state}.

Topics: accepted items, prohibited items, weight limits, street placement, size selection, dumpster differences, neighborhood delivery, booking, date changes, waste hauling

Return ONLY valid JSON:
{"faqs": [{"question": "...", "answer": "..."}], "wordCount": 1000}`,

    testimonials_cta: `Write EXACTLY 500 words for closing section of ${cityName}, ${state} dumpster rental page.

Include testimonials section and final CTA.

Return ONLY valid JSON:
{"content": "the full 500 word text", "wordCount": 500}`
  }

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: maxTokens,
    temperature: 0.7,
    messages: [{ role: 'user', content: prompts[section] }]
  })

  const contentText = response.content[0].type === 'text' ? response.content[0].text : ''
  const jsonMatch = contentText.match(/\{[\s\S]*\}/)
  
  if (!jsonMatch) throw new Error('No JSON in response')
  return JSON.parse(jsonMatch[0])
}

async function generateNeighborhoodSection(city, neighborhood, section, maxTokens) {
  const cityName = city.city
  const state = city.state_code
  
  const prompts = {
    intro_projects: `Write EXACTLY 800 words introducing dumpster rental in ${neighborhood}, ${cityName}, ${state}.

Return ONLY valid JSON:
{"content": "the full 800 word text", "wordCount": 800}`,

    service_details: `Write EXACTLY 600 words about service details for ${neighborhood}, ${cityName}, ${state}.

Return ONLY valid JSON:
{"content": "the full 600 word text", "wordCount": 600}`,

    faqs_cta: `Write EXACTLY 10 FAQs (total 700 words) + CTA (100 words) for ${neighborhood}, ${cityName}, ${state}.

Return ONLY valid JSON:
{"faqs": [{"question": "...", "answer": "..."}], "cta": "cta text", "wordCount": 800}`
  }

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: maxTokens,
    temperature: 0.7,
    messages: [{ role: 'user', content: prompts[section] }]
  })

  const contentText = response.content[0].type === 'text' ? response.content[0].text : ''
  const jsonMatch = contentText.match(/\{[\s\S]*\}/)
  
  if (!jsonMatch) throw new Error('No JSON in response')
  return JSON.parse(jsonMatch[0])
}

function assemblePagesFromSections(city, neighborhoods, sections) {
  const mainSections = sections.main || {}
  
  const mainPage = {
    type: 'main',
    title: `Dumpster Rental in ${city.city}, ${city.state_code} - Affordable Roll-Off Rentals`,
    metaDescription: `Professional dumpster rental in ${city.city}, ${city.state_code}. Fast delivery, transparent pricing.`,
    h1: `Dumpster Rental in ${city.city}, ${city.state_code}`,
    content: {
      heroServices: mainSections.hero_services?.content || '',
      areasWhyChoose: mainSections.areas_whychoose?.content || '',
      neighborhoods: mainSections.areas_whychoose?.neighborhoods || [],
      pricingProcess: mainSections.pricing_process?.content || '',
      faqsPart1: mainSections.faqs_part1?.faqs || [],
      faqsPart2: mainSections.faqs_part2?.faqs || [],
      testimonialsCta: mainSections.testimonials_cta?.content || ''
    },
    wordCount: 
      (mainSections.hero_services?.wordCount || 0) +
      (mainSections.areas_whychoose?.wordCount || 0) +
      (mainSections.pricing_process?.wordCount || 0) +
      (mainSections.faqs_part1?.wordCount || 0) +
      (mainSections.faqs_part2?.wordCount || 0) +
      (mainSections.testimonials_cta?.wordCount || 0),
    generatedAt: new Date().toISOString()
  }

  const neighborhoodPages = neighborhoods.map(neighborhood => {
    const key = `neighborhood_${neighborhood}`
    const nSections = sections[key] || {}
    
    return {
      type: 'neighborhood',
      neighborhoodName: neighborhood,
      title: `Dumpster Rental in ${neighborhood}, ${city.city}`,
      metaDescription: `Dumpster rental in ${neighborhood}, ${city.city}. Same-day delivery available.`,
      h1: `Dumpster Rental in ${neighborhood}, ${city.city}`,
      content: {
        introProjects: nSections.intro_projects?.content || '',
        serviceDetails: nSections.service_details?.content || '',
        faqs: nSections.faqs_cta?.faqs || [],
        cta: nSections.faqs_cta?.cta || ''
      },
      wordCount:
        (nSections.intro_projects?.wordCount || 0) +
        (nSections.service_details?.wordCount || 0) +
        (nSections.faqs_cta?.wordCount || 0),
      generatedAt: new Date().toISOString()
    }
  })

  return [mainPage, ...neighborhoodPages]
}

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`🚀 Content Generation Service running on port ${PORT}`)
})