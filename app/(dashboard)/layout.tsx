import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { slugify } from '@/lib/utils'
import { getOrCreateBusiness, insertOwnerAsEmployee } from '@/lib/create-business'
import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { Sidebar } from '@/components/layout/sidebar'
import { getAuthUser } from '@/lib/auth-user'

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createClient()
  const user = await getAuthUser()

  if (!user) redirect('/login')

  let { data: business } = await supabase
    .from('businesses')
    .select('id, name, slug, plan')
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
      redirect('/onboarding')
    } else {
      redirect('/login')
    }
  }

  // SaaS: if user is on the main domain, redirect to their subdomain preserving the path.
  // Covers /dashboard, /settings, /pos, /crm, /inventory, /booking — any app route.
  const rootDomain = process.env.NEXT_PUBLIC_ROOT_DOMAIN
  if (rootDomain && business?.slug) {
    const headersList = await headers()
    const host = headersList.get('host') ?? ''
    if (host === rootDomain || host === `www.${rootDomain}`) {
      // x-pathname is set by middleware on every request
      const pathname = headersList.get('x-pathname') ?? '/dashboard'
      redirect(`https://${business.slug}.${rootDomain}${pathname}`)
    }
  }

  return (
    <div className="fixed inset-0 flex overflow-hidden bg-gray-50">
      <Sidebar businessName={business.name} />
      <div className="flex-1 flex flex-col min-w-0 overflow-y-auto pt-14 md:pt-0">
        {children}
      </div>
    </div>
  )
}
