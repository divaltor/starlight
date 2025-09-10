"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Share2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
	createProfileShare,
	getProfileShare,
	revokeProfileShare,
} from "@/routes/api/share-profile";

interface ProfileShareSectionProps {
	rawInitData: string | undefined;
	embedded?: boolean;
}

export function ProfileShareSection({
	rawInitData,
	embedded = false,
}: ProfileShareSectionProps) {
	const queryClient = useQueryClient();
	const { data: profileShare, isLoading } = useQuery({
		queryKey: ["profile-share"],
		queryFn: async () => {
			return await getProfileShare({
				headers: { Authorization: rawInitData ?? "" },
			});
		},
		retry: false,
		enabled: !!rawInitData,
		staleTime: 5 * 60 * 1000,
		gcTime: 15 * 60 * 1000,
	});

	const createMutation = useMutation({
		mutationFn: async () => {
			return await createProfileShare({
				headers: { Authorization: rawInitData ?? "" },
			});
		},
		onSuccess: (result) => {
			queryClient.setQueryData(["profile-share"], {
				slug: result.slug,
				createdAt: new Date().toISOString(),
				revokedAt: null,
			});
		},
	});

	const revokeMutation = useMutation({
		mutationFn: async () => {
			return await revokeProfileShare({
				headers: { Authorization: rawInitData ?? "" },
			});
		},
		onSuccess: () => {
			queryClient.setQueryData(["profile-share"], (old: any) =>
				old ? { ...old, revokedAt: new Date().toISOString() } : old
			);
		},
	});

	const copyLink = async () => {
		if (!profileShare?.slug || profileShare?.revokedAt) return;
		const url = `${window.location.origin}/share/profile/${profileShare.slug}`;
		try {
			await navigator.clipboard.writeText(url);
			toast.success("Link copied", {
				position: "bottom-center",
				duration: 1600,
			});
		} catch {
			toast.error("Failed to copy link", { position: "bottom-center" });
		}
	};

	const isActive = !!profileShare?.slug && !profileShare?.revokedAt;

	return embedded ? (
		<div className="space-y-4">
			<div>
				<h2 className="flex items-center gap-2 font-medium text-gray-900 text-sm uppercase tracking-wide">
					<Share2 className="h-4 w-4" /> Profile Sharing
				</h2>
				<p className="mt-1 text-gray-500 text-sm">
					Allow others to view your gallery via a shareable link
				</p>
			</div>
			<div className="space-y-4">
				{isLoading ? (
					<div className="space-y-2">
						<Skeleton className="h-4 w-40" />
						<Skeleton className="h-8 w-full" />
					</div>
				) : isActive ? (
					<div className="flex flex-col gap-3 sm:flex-row sm:items-center">
						<div className="min-w-0 flex-1">
							<div className="flex h-8 w-full items-stretch overflow-hidden rounded-md border border-gray-200 bg-white">
								<button
									aria-label="Copy share link"
									className="min-w-0 flex-1 select-none overflow-hidden text-ellipsis whitespace-nowrap px-3 text-left font-mono text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 sm:text-sm"
									onClick={copyLink}
									type="button"
								>
									{`${window.location.origin}/share/profile/${profileShare.slug}`}
								</button>
								<button
									aria-label="Copy link"
									className="inline-flex items-center justify-center border-gray-200 border-l px-2 text-gray-500 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
									onClick={copyLink}
									type="button"
								>
									<Copy className="h-4 w-4" />
								</button>
							</div>
						</div>
						<Button
							className="w-full sm:w-auto"
							disabled={revokeMutation.isPending}
							onClick={() => revokeMutation.mutate()}
							size="sm"
							variant="destructive"
						>
							Disable
						</Button>
					</div>
				) : (
					<div className="flex flex-col gap-4">
						<p className="text-gray-600 text-sm">
							Your gallery is currently private. Enable sharing to generate a
							privacy-friendly link you can revoke at any time.
						</p>
						<Button
							className="flex items-center gap-2"
							disabled={createMutation.isPending}
							onClick={() => createMutation.mutate()}
							variant="default"
						>
							<Share2 className="h-4 w-4" /> Enable Sharing
						</Button>
					</div>
				)}
			</div>
		</div>
	) : (
		<Card className="border-0 bg-white/50 shadow-md backdrop-blur-sm">
			<CardHeader className="pb-1">
				<CardTitle className="flex items-center gap-2 font-medium text-gray-900 text-lg">
					<Share2 className="h-4 w-4" /> Profile Sharing
				</CardTitle>
				<CardDescription className="text-gray-500">
					Allow others to view your gallery via a shareable link
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				{isLoading ? (
					<div className="space-y-2">
						<Skeleton className="h-4 w-40" />
						<Skeleton className="h-8 w-full" />
					</div>
				) : isActive ? (
					<div className="flex flex-col gap-3 sm:flex-row sm:items-center">
						<div className="min-w-0 flex-1">
							<div className="flex h-8 w-full items-stretch overflow-hidden rounded-md border border-gray-200 bg-white">
								<button
									aria-label="Copy share link"
									className="min-w-0 flex-1 select-none overflow-hidden text-ellipsis whitespace-nowrap px-3 text-left font-mono text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 sm:text-sm"
									onClick={copyLink}
									type="button"
								>
									{`${window.location.origin}/share/profile/${profileShare.slug}`}
								</button>
								<button
									aria-label="Copy link"
									className="inline-flex items-center justify-center border-gray-200 border-l px-2 text-gray-500 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
									onClick={copyLink}
									type="button"
								>
									<Copy className="h-4 w-4" />
								</button>
							</div>
						</div>
						<Button
							className="w-full sm:w-auto"
							disabled={revokeMutation.isPending}
							onClick={() => revokeMutation.mutate()}
							size="sm"
							variant="destructive"
						>
							Disable
						</Button>
					</div>
				) : (
					<div className="flex flex-col gap-4">
						<p className="text-gray-600 text-sm">
							Your gallery is currently private. Enable sharing to generate a
							privacy-friendly link you can revoke at any time.
						</p>
						<Button
							className="flex items-center gap-2"
							disabled={createMutation.isPending}
							onClick={() => createMutation.mutate()}
							variant="default"
						>
							<Share2 className="h-4 w-4" /> Enable Sharing
						</Button>
					</div>
				)}
			</CardContent>
		</Card>
	);
}
