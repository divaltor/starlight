"use client";

import { motion } from "framer-motion";
import { EffectCards } from "swiper/modules";
import { Swiper, SwiperSlide } from "swiper/react";
import "swiper/css/effect-cards";
import "swiper/css";

import type { ReactNode } from "react";
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
		index: number
	) => ReactNode;
}) => {
	return (
		<motion.div
			animate={{ opacity: 1, translateY: 0 }}
			className={cn("relative w-full max-w-3xl", className)}
			transition={{
				duration: 0.3,
				delay: 0.5,
			}}
		>
			<Swiper
				effect="cards"
				grabCursor={true}
				modules={[EffectCards]}
				slideToClickedSlide={true}
				spaceBetween={spaceBetween}
			>
				{images.map((image, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: images may not have stable ids
					<SwiperSlide key={index}>{renderSlide(image, index)}</SwiperSlide>
				))}
			</Swiper>
		</motion.div>
	);
};

export { Carousel };
