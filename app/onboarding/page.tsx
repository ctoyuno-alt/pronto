import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { slugify } from '@/lib/utils'
import { getOrCreateBusiness, insertOwnerAsEmployee } from '@/lib/create-business'
import { redirect } from 'next/navigation'
import { OnboardingWizard } from './OnboardingWizard'

export default async function OnboardingPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  let { data: business } = await supabase
    .from('businesses')
    .select('id, slug, name, onboarding_completed')
    .eq('owner_id', user.id)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (!business) {
    const supabaseUrl = process.env.INTERNAL_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!
    const admin = createAdminClient(
      supabaseUrl,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
    const name = (user.user_metadata?.business_name as string) || 'My Business'
    const baseSlug = slugify(name) || 'my-business'
    const created = await getOrCreateBusiness(admin, {
      owner_id: user.id,
      name,
      slug: baseSlug,
    })
    if (created) {
      await insertOwnerAsEmployee(admin, created.id, user)
      business = {
        id: created.id,
        slug: created.slug,
        name,
        onboarding_completed: false,
      }
    } else {
      redirect('/login')
    }
  }

  // Guard: already onboarded → go straight to dashboard
  if (business.onboarding_completed) {
    const isSaas = process.env.NEXT_PUBLIC_DEPLOYMENT_MODE === 'saas'
    if (isSaas && business.slug) {
      const rootDomain = process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? 'trypronto.app'
      redirect(`https://${business.slug}.${rootDomain}/dashboard`)
    }
    redirect('/dashboard')
  }

  const isSaas = process.env.NEXT_PUBLIC_DEPLOYMENT_MODE === 'saas'

  return (
    <OnboardingWizard
      initialSlug={business.slug ?? ''}
      initialName={business.name ?? ''}
      isSaas={isSaas}
      rootDomain={process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? 'trypronto.app'}
    />
  )
}
