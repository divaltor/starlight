"use client";

import { CollectionShareVisibility } from "@repo/utils";
import { useState } from "react";
import { Checkbox } from "@/components/animate-ui/components/radix/checkbox";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { useCollectionMutations } from "@/hooks/useCollectionMutations";

interface CollectionCreateDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	defaultVisibility?: CollectionShareVisibility;
}

export function CollectionCreateDialog({
	open,
	onOpenChange,
	defaultVisibility = CollectionShareVisibility.PRIVATE,
}: CollectionCreateDialogProps) {
	const [name, setName] = useState("");
	const [visibility, setVisibility] =
		useState<CollectionShareVisibility>(defaultVisibility);
	const { createCollection, creating } = useCollectionMutations();

	const handleCreate = () => {
		createCollection(
			{
				name: name.trim() || undefined,
				visibility,
			},
			{
				onSuccess: () => {
					setName("");
					onOpenChange(false);
				},
			},
		);
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>New Collection</DialogTitle>
					<DialogDescription>
						Organize favorite tweets into a named collection.
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-4">
					<div className="space-y-1">
						<label
							className="block font-medium text-gray-700 text-sm"
							htmlFor="name"
						>
							Name
						</label>
						<input
							type="text"
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder="Favorites"
							className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
							maxLength={80}
						/>
					</div>
					<div className="space-y-2">
						<label
							className="flex cursor-pointer items-center gap-2 text-sm"
							htmlFor="visibility"
						>
							<Checkbox
								id="visibility"
								checked={visibility === CollectionShareVisibility.PUBLIC}
								onCheckedChange={(checked) => {
									setVisibility(
										checked === true
											? CollectionShareVisibility.PUBLIC
											: CollectionShareVisibility.PRIVATE,
									);
								}}
								aria-label="Make collection visible to others"
							/>
							<span>Make this collection public</span>
						</label>
						<p className="text-gray-500 text-xs">
							When public, anyone with a link can view it. Leave unchecked to
							keep it private.
						</p>
					</div>
				</div>
				<DialogFooter>
					<Button
						variant="secondary"
						onClick={() => onOpenChange(false)}
						className="sm:w-auto"
					>
						Cancel
					</Button>
					<Button
						onClick={handleCreate}
						disabled={creating}
						className="sm:w-auto"
					>
						{creating ? "Creating..." : "Create"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
