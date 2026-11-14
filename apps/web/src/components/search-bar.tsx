import type { Outputs } from "@starlight/api/routers/index";
import { Autocomplete } from "@base-ui/react/autocomplete";
import Search01Icon from "@hugeicons/core-free-icons/Search01Icon";
import { HugeiconsIcon } from "@hugeicons/react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { orpc } from "@/utils/orpc";

type Artist = Outputs["artists"]["search"][number];

interface SearchBarProps {
  isLoading: boolean;
  onChange: (value: string) => void;
  onSearch: (query: string) => void;
  value: string;
}

// Plain text runs the image search; "@name" suggests artists and opens the chosen artist's page.
export function SearchBar({ isLoading, onChange, onSearch, value }: SearchBarProps) {
  const navigate = useNavigate();
  const anchorRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const artistQuery = value.trim().startsWith("@") ? value.trim().slice(1) : "";

  const { data: artists = [], isFetching: isFetchingArtists } = useQuery({
    ...orpc.artists.search.queryOptions({ input: { query: artistQuery } }),
    enabled: artistQuery.length > 0,
    placeholderData: keepPreviousData,
  });

  const openArtist = (username: string) => {
    setIsOpen(false);
    void navigate({ to: "/artist/@{$username}", params: { username } });
  };

  const handleSubmit = (e: React.SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();

    if (artistQuery) {
      openArtist(
        artists.find((artist) => artist.username.toLowerCase() === artistQuery.toLowerCase())?.username ?? artistQuery,
      );

      return;
    }

    onSearch(value.trim());
  };

  return (
    <form onSubmit={handleSubmit}>
      <Autocomplete.Root
        autoHighlight
        itemToStringValue={(artist: Artist) => `@${artist.username}`}
        items={artistQuery ? artists : []}
        mode="none"
        onOpenChange={setIsOpen}
        onValueChange={(next, details) => {
          // Picking a suggestion writes "@username" into the input; open that artist instead.
          if (details.reason === "item-press") {
            openArtist(next.slice(1));

            return;
          }

          onChange(next);
        }}
        open={isOpen && artistQuery.length > 0}
        value={value}
      >
        <ButtonGroup className="w-full" ref={anchorRef}>
          <Autocomplete.Input
            aria-label="Search for images or @artists"
            placeholder="Search for images or @artist…"
            render={<Input className="bg-background" />}
          />
          <Button aria-label="Search" disabled={isLoading} type="submit">
            {isLoading ? <Spinner /> : <HugeiconsIcon className="size-4" icon={Search01Icon} />}
            <span className="hidden sm:inline">Search</span>
          </Button>
        </ButtonGroup>
        <Autocomplete.Portal>
          <Autocomplete.Positioner anchor={anchorRef} className="isolate z-50" sideOffset={6}>
            <Autocomplete.Popup className="max-h-(--available-height) w-(--anchor-width) origin-(--transform-origin) overflow-hidden rounded-md bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 transition-[opacity,scale] duration-150 ease-out data-ending-style:opacity-0 data-starting-style:opacity-0 motion-safe:data-ending-style:scale-95 motion-safe:data-starting-style:scale-95">
              <Autocomplete.Empty className="py-2 text-center text-muted-foreground text-sm empty:hidden">
                {isFetchingArtists ? "Searching artists…" : "No artists found"}
              </Autocomplete.Empty>
              <Autocomplete.List className="max-h-72 scroll-py-1 overflow-y-auto overscroll-contain p-1 data-empty:p-0">
                {(artist: Artist) => (
                  <Autocomplete.Item
                    className="flex w-full cursor-default items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
                    key={artist.username}
                    value={artist}
                  >
                    <span className="truncate font-medium">@{artist.username}</span>
                    <span className="text-muted-foreground text-xs">
                      {artist.artCount} {artist.artCount === 1 ? "art" : "arts"}
                    </span>
                  </Autocomplete.Item>
                )}
              </Autocomplete.List>
            </Autocomplete.Popup>
          </Autocomplete.Positioner>
        </Autocomplete.Portal>
      </Autocomplete.Root>
    </form>
  );
}
