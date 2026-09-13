import { NextResponse } from 'next/server'
import {
  getCurrentAccount,
  UnauthorizedError,
  ForbiddenError,
} from '@/lib/auth/account'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ mediaId: string }> }
) {
  try {
    const { mediaId } = await params

    if (!mediaId) {
      return NextResponse.json(
        { error: 'Media ID is required' },
        { status: 400 }
      )
    }

    // Status-aware account context: a suspended account's config row is
    // RLS-hidden post-migration 041, so a plain session + profile read
    // would degrade to "WhatsApp not configured" instead of the 403 the
    // user is owed. getCurrentAccount() answers with the right status.
    let supabase: Awaited<ReturnType<typeof getCurrentAccount>>['supabase']
    let accountId: string
    try {
      const ctx = await getCurrentAccount()
      supabase = ctx.supabase
      accountId = ctx.accountId
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        return NextResponse.json(
          { error: 'Unauthorized' },
          { status: 401 }
        )
      }
      if (err instanceof ForbiddenError) {
        const message = err.message.includes('suspended')
          ? err.message
          : 'Your profile is not linked to an account.'
        return NextResponse.json({ error: message }, { status: 403 })
      }
      throw err
    }

    // Fetch and decrypt WhatsApp config
    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .single()

    if (configError || !config) {
      return NextResponse.json(
        { error: 'WhatsApp not configured' },
        { status: 400 }
      )
    }

    const accessToken = decrypt(config.access_token)

    // Get the download URL from Meta
    const mediaInfo = await getMediaUrl({ mediaId, accessToken })

    // Download the binary data
    const { buffer, contentType } = await downloadMedia({
      downloadUrl: mediaInfo.url,
      accessToken,
    })

    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': contentType || mediaInfo.mimeType || 'application/octet-stream',
        'Cache-Control': 'public, max-age=86400',
      },
    })
  } catch (error) {
    console.error('Error in WhatsApp media GET:', error)
    return NextResponse.json(
      { error: 'Failed to fetch media' },
      { status: 500 }
    )
  }
}
