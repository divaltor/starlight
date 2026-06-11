"use client";

import { LazyMotion } from "motion/react";
// biome-ignore lint/performance/noNamespaceImport: motion/react-m is designed for namespace component access like m.div
import * as m from "motion/react-m";

const loadDomAnimation = () => import("motion/react").then((m) => m.domAnimation);

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

const Carousel = ({
	images,
	className,
	spaceBetween = 20,
	renderSlide,
}: {
	images: {
		src: string;
		alt: string;
		id?: string;
		height?: number;
		width?: number;
		is_nsfw?: boolean;
	}[];
	className?: string;
	spaceBetween?: number;
	renderSlide: (
		image: {
			src: string;
			alt: string;
			id?: string;
			height?: number;
			width?: number;
			is_nsfw?: boolean;
		},
		index: number,
	) => ReactNode;
}) => {
	const trackRef = useRef<HTMLDivElement>(null);
	const [activeIndex, setActiveIndex] = useState(0);

	const handleScroll = useCallback(() => {
		const track = trackRef.current;
		if (!track) return;

		const trackCenter = track.scrollLeft + track.clientWidth / 2;
		const slides = track.children;
		let closest = 0;
		let closestDist = Infinity;

		for (let i = 0; i < slides.length; i++) {
			const slide = slides[i] as HTMLElement;
			const slideCenter = slide.offsetLeft + slide.clientWidth / 2;
			const dist = Math.abs(trackCenter - slideCenter);
			if (dist < closestDist) {
				closestDist = dist;
				closest = i;
			}
		}

		setActiveIndex(closest);
	}, []);

	useEffect(() => {
		const track = trackRef.current;
		if (!track) return;

		track.addEventListener("scroll", handleScroll, { passive: true });
		handleScroll(); // set initial index

		return () => track.removeEventListener("scroll", handleScroll);
	}, [handleScroll]);

	const handleClick = (e: React.MouseEvent) => {
		const track = trackRef.current;
		if (!track) return;

		const slide = (e.target as HTMLElement).closest("[data-slide]") as HTMLElement;
		if (!slide) return;

		const trackCenter = track.scrollLeft + track.clientWidth / 2;
		const slideCenter = slide.offsetLeft + slide.clientWidth / 2;

		if (Math.abs(trackCenter - slideCenter) > slide.clientWidth * 0.2) {
			slide.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
		}
	};

	if (images.length === 0) return null;

	return (
		<LazyMotion features={loadDomAnimation}>
			<m.div
				animate={{ opacity: 1, translateY: 0 }}
				className={cn("relative w-full max-w-3xl", className)}
				transition={{
					duration: 0.3,
					delay: 0.5,
				}}
			>
				<div
					className="flex snap-x snap-mandatory overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
					onClick={handleClick}
					ref={trackRef}
					style={{
						gap: `${spaceBetween}px`,
						paddingInline: `calc(50% - 150px)`,
						scrollPaddingInline: `calc(50% - 150px)`,
						perspective: "1200px",
						cursor: "grab",
					}}
				>
					{images.map((image, index) => {
						const offset = index - activeIndex;
						const isActive = offset === 0;

						return (
							<div
								className="flex-shrink-0 snap-center"
								data-slide
								key={image.id ?? index}
								style={{
									width: "300px",
									transformStyle: "preserve-3d",
									transition: "transform 0.4s ease",
									transform: isActive
										? "translateZ(0px) rotateY(0deg)"
										: `translateX(${offset * 20}px) translateZ(-${Math.abs(offset) * 100}px) rotateY(${offset * 25}deg)`,
									zIndex: isActive ? 10 : 1,
								}}
							>
								{renderSlide(image, index)}
							</div>
						);
					})}
				</div>
			</m.div>
		</LazyMotion>
	);
};

export { Carousel };
