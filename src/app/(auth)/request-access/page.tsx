"use client";

// ============================================================
// /request-access — public "Request Access" form.
//
// An uninvited visitor fills in their details. Submitting only records
// a PENDING access request — it does NOT create an Auth user or
// authorize signup. A platform admin reviews the request and, if
// approved, sends the visitor a secure /signup?customer_invite=<token>
// link, which is what actually authorizes account creation.
// ============================================================

import { useState } from "react";
import Link from "next/link";
import { CheckCircle, Loader2, Lock, MessageSquare, Send } from "lucide-react";
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

export default function RequestAccessPage() {
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [message, setMessage] = useState("");
  const [referralCode, setReferralCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/access-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          full_name: fullName,
          email,
          company_name: companyName,
          message,
          referral_code: referralCode,
        }),
      });
      // 400 / 422 / 429 / duplicate all resolve to a generic "received"
      // or "could not process" message — we deliberately avoid revealing
      // whether this email already has a request or an account.
      if (res.ok) {
        setSubmitted(true);
      } else if (res.status === 429) {
        setError("You've submitted too many requests. Please try again later.");
      } else {
        setError("Your request could not be processed. Please try again.");
      }
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  if (submitted) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <Card className="w-full max-w-md border-border bg-card">
          <CardHeader className="items-center text-center">
            <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
              <CheckCircle className="h-6 w-6 text-primary" />
            </div>
            <CardTitle className="text-xl text-foreground">
              Request received
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              Thanks, {fullName || "there"}. Your request has been received
              and is pending review. If approved, you&apos;ll be sent a secure
              signup link to{" "}
              <span className="text-foreground">{email}</span>.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/login">
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
            <MessageSquare className="h-6 w-6 text-primary" />
          </div>
          <CardTitle className="text-xl text-foreground">
            Request access
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            Don&apos;t have an invitation yet? Request access and our team
            will review your details. If approved, you&apos;ll get a signup link.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
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
                maxLength={120}
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
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
                maxLength={254}
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="companyName" className="text-muted-foreground">
                Company name
              </Label>
              <Input
                id="companyName"
                type="text"
                placeholder="Acme Inc."
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                maxLength={120}
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="message" className="text-muted-foreground">
                Message{" "}
                <span className="text-muted-foreground/60">(optional)</span>
              </Label>
              <textarea
                id="message"
                placeholder="Anything that helps us review your request…"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                maxLength={2000}
                rows={4}
                className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="referralCode" className="text-muted-foreground">
                Referral / source code{" "}
                <span className="text-muted-foreground/60">(optional)</span>
              </Label>
              <Input
                id="referralCode"
                type="text"
                placeholder="e.g. PARTNER2026"
                value={referralCode}
                onChange={(e) => setReferralCode(e.target.value)}
                maxLength={100}
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
              />
            </div>

            <Button
              type="submit"
              disabled={loading}
              className="mt-2 h-10 w-full bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {loading ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Submitting…
                </>
              ) : (
                <>
                  <Send className="size-4" />
                  Request access
                </>
              )}
            </Button>

            <p className="mt-1 flex items-center justify-center gap-1 text-center text-xs text-muted-foreground">
              <Lock className="size-3" />
              This does not create an account. You&apos;ll only be able to sign
              up if your request is approved.
            </p>
          </form>

          <p className="mt-6 text-center text-sm text-muted-foreground">
            Already have an invitation or an account?{" "}
            <Link
              href="/login"
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
