"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { clientAuthRedirectOrigin } from "@/lib/auth/redirect-url";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { MessageSquare, CheckCircle, UsersRound } from "lucide-react";

function signupErrorMessage(error: { message?: unknown }): string {
  const message = typeof error.message === "string" ? error.message.trim() : "";

  // Supabase Auth often collapses a BEFORE INSERT trigger rejection into
  // "Database error saving new user" (or an empty serialized object). Keep
  // the database gate authoritative, but turn that implementation detail
  // into an actionable message for an uninvited visitor.
  if (
    !message ||
    message === "{}" ||
    message.toLowerCase().includes("database error saving new user") ||
    message.toLowerCase().includes("invite-only")
  ) {
    // Guidance only — it reveals nothing about which email/account
    // exists, just pushes the visitor to the most common real-world
    // cause (signing up with a different email than the invited one).
    // No enumeration: every rejection condition maps to the same text.
    return "Sign-up is invitation-only. Make sure you're using the exact email address that was invited and that your invitation link hasn't expired — or contact the platform administrator.";
  }

  return message;
}

// `useSearchParams` opts the component out of static prerendering
// unless wrapped in Suspense — same pattern as /login.
export default function SignupPage() {
  return (
    <Suspense fallback={null}>
      <SignupPageInner />
    </Suspense>
  );
}

function SignupPageInner() {
  const searchParams = useSearchParams();
  // Two independent invite channels add a token to the URL:
  //   - `customer_invite` — platform-approved customer signup (a
  //     platform admin sent /signup?customer_invite=<token>).
  //   - `invite` — team /join/<token> flow (a teammate joins an
  //     account).
  // The token is carried through the signup → email verification →
  // redirect round-trip. `emailRedirectTo` points every confirmation
  // back at /auth/callback (which preserves the invite context and
  // lands the user on the right next step) instead of Supabase's
  // default.
  const customerInviteToken = searchParams.get("customer_invite");
  const inviteToken = searchParams.get("invite");
  const channel = customerInviteToken
    ? ("platform" as const)
    : inviteToken
      ? ("team" as const)
      : (null as "platform" | "team" | null);

  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const supabase = createClient();

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    if (password.length < 6) {
      setError("Password must be at least 6 characters");
      return;
    }

    setLoading(true);

    // Every signup confirmation routes through /auth/callback so the
    // one-time `code` is exchanged into a session before redirecting.
    // `next` carries the invite context:
    //   - platform invite → /dashboard (the account/profile already
    //     exist; confirmation completes onboarding).
    //   - team invite → /join/<token> (they still must accept).
    // The callback's safeNextPath() rejects anything non-same-origin.
    const origin = clientAuthRedirectOrigin();
    let emailRedirectTo: string | undefined;
    if (customerInviteToken) {
      emailRedirectTo = `${origin}/auth/callback?next=${encodeURIComponent(
        "/dashboard",
      )}`;
    } else if (inviteToken) {
      emailRedirectTo = `${origin}/auth/callback?next=${encodeURIComponent(
        `/join/${inviteToken}`,
      )}`;
    }

    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: fullName,
          // Carry the platform customer-invite token through so the
          // server-side gate (enforce_signup_gate, migration 043) can
          // validate it against platform_customer_invites and bind
          // the signup to the approved email.
          ...(customerInviteToken
            ? { customer_invite_token: customerInviteToken }
            : {}),
          // The team /join/<token> invite token is validated against
          // account_invitations by the same gate.
          ...(inviteToken ? { invite_token: inviteToken } : {}),
        },
        ...(emailRedirectTo ? { emailRedirectTo } : {}),
      },
    });

    if (error) {
      console.debug("[signup] rejected:", error.message);
      setError(signupErrorMessage(error));
      setLoading(false);
      return;
    }

    setSuccess(true);
    setLoading(false);
  };

  if (success) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <Card className="w-full max-w-md border-border bg-card">
          <CardHeader className="items-center text-center">
            <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
              <CheckCircle className="h-6 w-6 text-primary" />
            </div>
            <CardTitle className="text-xl text-foreground">
              Check your email
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              We&apos;ve sent a confirmation link to{" "}
              <span className="text-foreground">{email}</span>. Please check your
              inbox and click the link to verify your account.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link
              href={
                channel === "team" && inviteToken
                  ? `/login?invite=${encodeURIComponent(inviteToken)}`
                  : "/login"
              }
            >
              <Button
                variant="outline"
                className="w-full border-border text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                Back to sign in
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md border-border bg-card">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
            {channel === "team" ? (
              <UsersRound className="h-6 w-6 text-primary" />
            ) : channel === "platform" ? (
              <CheckCircle className="h-6 w-6 text-primary" />
            ) : (
              <MessageSquare className="h-6 w-6 text-primary" />
            )}
          </div>
          <CardTitle className="text-xl text-foreground">
            {channel === "team"
              ? "Create account & join"
              : "Create your account"}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {channel === "team"
              ? "Verify your email, then accept the invitation to join your team."
              : channel === "platform"
                ? "You've been approved to sign up. Use the invited email to create your account."
                : "Get started with WaPilot"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSignup} className="flex flex-col gap-4">
            {error && (
              <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                {error}
              </div>
            )}

            <div className="flex flex-col gap-2">
              <Label htmlFor="fullName" className="text-muted-foreground">
                Full name
              </Label>
              <Input
                id="fullName"
                type="text"
                placeholder="John Doe"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                required
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="email" className="text-muted-foreground">
                Email
              </Label>
              <Input
                id="email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="password" className="text-muted-foreground">
                Password
              </Label>
              <Input
                id="password"
                type="password"
                placeholder="At least 6 characters"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="confirmPassword" className="text-muted-foreground">
                Confirm password
              </Label>
              <Input
                id="confirmPassword"
                type="password"
                placeholder="Repeat your password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
              />
            </div>

            <Button
              type="submit"
              disabled={loading}
              className="mt-2 h-10 w-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {loading ? "Creating account..." : "Create account"}
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-muted-foreground">
            Already have an account?{" "}
            <Link
              href={
                channel === "team" && inviteToken
                  ? `/login?invite=${encodeURIComponent(inviteToken)}`
                  : "/login"
              }
              className="text-primary hover:text-primary/80"
            >
              Sign in
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
