import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Share2 } from "lucide-react";
import { toast } from "sonner";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { orpc } from "@/utils/orpc";

type ProfileShareSectionProps = {
	rawInitData: string | undefined;
	embedded?: boolean;
};

export function ProfileShareSection({
	rawInitData,
	embedded = false,
}: ProfileShareSectionProps) {
	const queryClient = useQueryClient();
	const { data: userProfile, isLoading } = useQuery(
		orpc.profiles.get.queryOptions({
			queryKey: ["user-profile"],
			enabled: !!rawInitData,
			retry: false,
		})
	);

	const makeProfilePublicMutation = useMutation(
		orpc.profiles.visibility.mutationOptions({
			onSuccess: () => {
				queryClient.invalidateQueries({ queryKey: ["user-profile"] });
			},
			mutationFn: () => orpc.profiles.visibility.call({ status: "public" }),
		})
	);

	const makeProfilePrivateMutation = useMutation(
		orpc.profiles.visibility.mutationOptions({
			onSuccess: () => {
				queryClient.invalidateQueries({ queryKey: ["user-profile"] });
			},
			mutationFn: () => orpc.profiles.visibility.call({ status: "private" }),
		})
	);

	const copyLink = async () => {
		if (!userProfile?.username) {
			return;
		}

		const url = `${window.location.origin}/profile/${userProfile?.username}`;

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

	const isActive = userProfile?.isPublic;

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
			<CardContent className="space-y-4" />
		</Card>
	);
}
