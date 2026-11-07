import type { ProfileResult } from "@starlight/api/routers/index";
import AlertCircleIcon from "@hugeicons/core-free-icons/AlertCircleIcon";
import CookieIcon from "@hugeicons/core-free-icons/CookieIcon";
import Delete02Icon from "@hugeicons/core-free-icons/Delete02Icon";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, useSyncExternalStore } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useTelegramContext } from "@/providers/telegram-buttons-provider";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/settings")({
  component: RouteComponent,
  loader: async ({ context: { queryClient } }) => {
    if (import.meta.env.SSR) {
      return;
    }

    const profileOptions = orpc.profiles.get.queryOptions({
      queryKey: ["profile"],
      enabled: true,
      staleTime: 5 * 60 * 1000,
      gcTime: 30 * 60 * 1000,
      retry: 1,
    });

    await queryClient.query(profileOptions).catch(() => {
      // The profile query renders its error in the settings view.
    });
  },
});

function RouteComponent() {
  const [newCookies, setNewCookies] = useState("");

  const { rawInitData } = useTelegramContext();
  const queryClient = useQueryClient();

  const profileQuery = useQuery(
    orpc.profiles.get.queryOptions({
      queryKey: ["profile"],
      enabled: (rawInitData?.length ?? 0) > 0,
      staleTime: 5 * 60 * 1000,
      gcTime: 30 * 60 * 1000,
      retry: 1,
    }),
  );

  const saveCookiesMutation = useMutation(
    orpc.cookies.save.mutationOptions({
      onSuccess: () => {
        queryClient.setQueryData(["profile"], (old: ProfileResult) => ({
          ...old,
          hasValidCookies: true,
        }));
        setNewCookies("");
      },
    }),
  );

  const deleteCookiesMutation = useMutation(
    orpc.cookies.delete.mutationOptions({
      onSuccess: () => {
        queryClient.setQueryData(["profile"], (old: ProfileResult) => ({
          ...old,
          hasValidCookies: false,
        }));
      },
    }),
  );

  const visibilityMutation = useMutation(
    orpc.profiles.visibility.mutationOptions({
      onSuccess: (_data: { success: boolean }, variables: { status: "public" | "private" }) => {
        queryClient.setQueryData(["profile"], (old: ProfileResult) => ({
          ...old,
          user: {
            ...old.user,
            isPublic: variables.status === "public",
          },
        }));
      },
    }),
  );

  if (profileQuery.status === "pending") {
    return <SettingsPageSkeleton />;
  }

  if (profileQuery.status === "error") {
    return (
      <SettingsLoadError
        onRetry={() => {
          void profileQuery.refetch();
        }}
      />
    );
  }

  const profile = profileQuery.data;
  const isSubmitting = saveCookiesMutation.isPending || deleteCookiesMutation.isPending || visibilityMutation.isPending;

  return (
    <main className="container mx-auto max-w-2xl px-4 py-10">
      <Card>
        <CardContent className="space-y-6">
          {/* Cookie Management Section */}
          <CookiesSection
            saveError={saveCookiesMutation.error}
            deleteError={deleteCookiesMutation.error}
            isSubmitting={isSubmitting}
            newCookies={newCookies}
            onDelete={() => {
              deleteCookiesMutation.mutate({});
            }}
            onSave={(cookies) => {
              saveCookiesMutation.mutate({ cookies });
            }}
            profile={profile}
            setNewCookies={(cookies) => {
              setNewCookies(cookies);
              saveCookiesMutation.reset();
            }}
          />

          {/* Profile Visibility Section */}
          <VisibilitySection
            error={visibilityMutation.error}
            disabled={isSubmitting}
            isPublic={profile.user.isPublic}
            onToggle={(status) => {
              visibilityMutation.mutate({ status });
            }}
          />
        </CardContent>
        {/* Profile Block - Shown when public */}
        {profile.user.isPublic && <ProfileLinkBlock username={profile.user.username} />}
      </Card>
    </main>
  );
}

function SettingsPageSkeleton() {
  return (
    <main className="container mx-auto max-w-2xl px-4 py-10">
      <div className="mb-8 flex items-center justify-between">
        <h1 className="font-semibold text-2xl text-foreground">Settings</h1>
      </div>
      <Card>
        <CardHeader className="pb-1">
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-4 w-64" />
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-6 w-16" />
            </div>
            <Skeleton className="h-10 w-full" />
          </div>
          <div className="space-y-4">
            <Skeleton className="h-12 w-full" />
            <div className="space-y-2">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-8 w-32" />
            </div>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}

function SettingsLoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <main className="container mx-auto max-w-2xl px-4 py-10">
      <Card>
        <CardContent className="py-8">
          <Alert variant="destructive">
            <HugeiconsIcon className="size-4" icon={AlertCircleIcon} />
            <AlertTitle>Failed to load settings</AlertTitle>
            <AlertDescription className="mt-2">
              <Button onClick={onRetry} size="sm" variant="outline">
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    </main>
  );
}

function CookiesSection({
  saveError,
  deleteError,
  isSubmitting,
  newCookies,
  onDelete,
  onSave,
  profile,
  setNewCookies,
}: {
  saveError: Error | null;
  deleteError: Error | null;
  isSubmitting: boolean;
  newCookies: string;
  onDelete: () => void;
  onSave: (cookies: string) => void;
  profile: ProfileResult;
  setNewCookies: (cookies: string) => void;
}) {
  return (
    <section className="space-y-4">
      <h2 className="font-semibold text-foreground text-sm uppercase tracking-wide">Authentication Cookies</h2>

      {/* Cookie Success/Error Messages */}
      {deleteError && (
        <Alert variant="destructive">
          <HugeiconsIcon className="size-4" icon={AlertCircleIcon} />
          <AlertTitle>{deleteError.message}</AlertTitle>
        </Alert>
      )}
      {profile.hasValidCookies ? (
        <Alert>
          <HugeiconsIcon className="size-4 shrink-0" icon={CookieIcon} />
          <AlertTitle>Authentication cookies are saved.</AlertTitle>
          <AlertDescription className="mt-2">
            <Button disabled={isSubmitting} onClick={onDelete} size="sm" variant="destructive">
              <HugeiconsIcon className="size-4" icon={Delete02Icon} /> Remove
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <div className="space-y-4">
          <Alert variant="default">
            <HugeiconsIcon className="size-4" icon={AlertCircleIcon} />
            <AlertDescription>Connect your Twitter account by adding authentication cookies</AlertDescription>
          </Alert>

          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              onSave(newCookies);
            }}
          >
            <div className="space-y-2">
              <Textarea
                aria-invalid={saveError !== null}
                disabled={isSubmitting}
                id="new-cookies"
                onChange={(e) => {
                  setNewCookies(e.target.value);
                }}
                placeholder="Paste your authentication cookies here"
                value={newCookies}
              />
              {saveError && (
                <p className="text-destructive text-sm" role="alert">
                  {saveError.message}
                </p>
              )}
            </div>

            <div className="flex gap-2">
              <Button disabled={isSubmitting} size="sm" type="submit">
                Save cookies
              </Button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}

function VisibilitySection({
  error,
  disabled,
  isPublic,
  onToggle,
}: {
  error: Error | null;
  disabled: boolean;
  isPublic: boolean;
  onToggle: (status: "public" | "private") => void;
}) {
  return (
    <section className="space-y-4">
      {error && (
        <Alert variant="destructive">
          <HugeiconsIcon className="size-4" icon={AlertCircleIcon} />
          <AlertTitle>{error.message}</AlertTitle>
        </Alert>
      )}
      <div className="flex items-center gap-2">
        <Switch
          checked={isPublic}
          disabled={disabled}
          id="profile-visibility"
          onCheckedChange={(checked) => {
            onToggle(checked ? "public" : "private");
          }}
        />
        <Label htmlFor="profile-visibility">Make your profile visible to other people</Label>
      </div>
    </section>
  );
}

// The origin cannot change during a page's lifetime, so subscribing would be
// a no-op; only the snapshots matter to useSyncExternalStore.
function subscribeToOrigin() {
  return () => {
    // Nothing to clean up.
  };
}

function ProfileLinkBlock({ username }: { username: string }) {
  // window is unavailable during SSR; useSyncExternalStore renders the
  // path-only form on the server and upgrades to the absolute URL on mount.
  const origin = useSyncExternalStore(
    subscribeToOrigin,
    () => window.location.origin,
    () => "",
  );

  return (
    <CardFooter className="border-t">
      <p className="text-muted-foreground text-sm">
        Link to your profile:{" "}
        <Link className="underline underline-offset-4" params={{ slug: username }} to="/profile/$slug">
          {`${origin}/profile/${username}`}
        </Link>
      </p>
    </CardFooter>
  );
}
